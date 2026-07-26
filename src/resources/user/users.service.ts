import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DeviceToken, TrustedContact, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../providers/redis/redis.service';
import { normalizeEmail } from '../../common/transforms/normalize-email';
import type { CreateContactDto } from './dto/create-contact.dto';
import type { CreateContactGroupDto } from './dto/create-contact-group.dto';
import type { ListContactGroupsQueryDto } from './dto/list-contact-groups.query.dto';
import type { ListContactsQueryDto } from './dto/list-contacts.query.dto';
import type { RegisterDeviceDto } from './dto/register-device.dto';
import type { UpdateContactDto } from './dto/update-contact.dto';
import type { UpdateContactGroupDto } from './dto/update-contact-group.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import { ThrottlerException } from '@nestjs/throttler';
import {
  CONTACT_GROUP_MEMBERS_INCLUDE,
  CONTACT_GROUP_NOT_FOUND,
  CONTACT_GROUP_ORDER_BY,
  CONTACT_LOOKUP_MAX_PER_WINDOW,
  CONTACT_LOOKUP_NO_ACCOUNT,
  CONTACT_LOOKUP_RATE_LIMITED,
  CONTACT_LOOKUP_SELECT,
  CONTACT_LOOKUP_SELF,
  CONTACT_LOOKUP_SELF_CODE,
  CONTACT_LOOKUP_WINDOW_S,
  CONTACT_NEEDS_REACHABLE_FIELD,
  CONTACT_NOT_FOUND,
  CONTACT_PAGE_DEFAULT_LIMIT,
  CONTACT_PAGE_MAX_LIMIT,
  CONTACT_PAGE_ORDER_BY,
  CONTACT_SELF_LINK,
  CONTACT_USER_SELECT,
  DUPLICATE_LINKED_CONTACT,
  GOOGLE_NO_ACCOUNT_CODE,
  LINKED_USER_NOT_FOUND,
  contactIdsNotYours,
  contactLookupAlreadyAdded,
  contactLookupFound,
  contactLookupQuotaKey,
  duplicateContactGroupName,
  googleEmailLinkedElsewhere,
  googleEmailNotVerified,
  googleNoAccount,
} from './constant/users.constants';
import type {
  ContactGroupView,
  ContactGroupWithMembers,
  ContactUserLookupResult,
  ContactWithLinkedUser,
  GoogleIdentity,
  GoogleUpsertOptions,
  PaginatedContacts,
  ProfileWithCounts,
  UserProfile,
} from './type/users.types';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ── contract methods (consumed by auth/sos/alerts modules) ────────────

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /**
   * Resolves a verified Google identity to a user row, in priority order:
   *
   *  1. Known `googleSub` → normal sign-in; refresh email/name/avatarUrl.
   *  2. Nobody has that sub, but the email already exists on an account with no
   *     googleSub → LINK: stamp the sub onto that account and sign them in. The
   *     passwordHash is left untouched, so email/password keeps working too.
   *  3. Email is free → create a fresh Google account, UNLESS the caller is in
   *     login-only mode (`allowSignup: false`), in which case nothing is
   *     written and a 404 `{ code: 'NO_ACCOUNT' }` is thrown.
   *
   * Only a *different, non-null* googleSub on that email is a real conflict.
   *
   * Steps 1 and 2 are identical in both modes: resolving to an account that
   * already exists is a SIGN-IN, never a sign-up, so login-only mode must not
   * weaken the email_verified gate or the password-revocation rule in
   * {@link linkGoogleIdentity}.
   */
  async upsertFromGoogle(
    p: GoogleIdentity,
    options: GoogleUpsertOptions = {},
  ): Promise<User> {
    // Default true: the mobile app calls this with no options and must keep
    // creating accounts on first Google sign-in exactly as before.
    const allowSignup = options.allowSignup ?? true;
    const email = normalizeEmail(p.email);

    const bySub = await this.prisma.user.findUnique({
      where: { googleSub: p.sub },
    });
    if (bySub) return this.refreshGoogleProfile(bySub, p, email);

    const byEmail = await this.prisma.user.findUnique({ where: { email } });
    if (byEmail) return this.linkGoogleIdentity(byEmail, p, email);

    if (!allowSignup) {
      // Nobody owns this sub and nobody owns this email, so continuing would
      // CREATE an account. On the web that account would be a shell: no verified
      // email flow, no push token, no trusted contacts. Refuse before any write
      // and hand back a code the caller can branch on.
      this.logger.log(
        `Login-only Google sign-in refused for ${email}: no RoamWarden account exists`,
      );
      throw new NotFoundException({
        code: GOOGLE_NO_ACCOUNT_CODE,
        message: googleNoAccount(email),
      });
    }

    try {
      return await this.prisma.user.create({
        data: {
          googleSub: p.sub,
          email,
          name: p.name,
          avatarUrl: p.avatarUrl ?? null,
          // Google asserting email_verified is the proof our OTP flow demands,
          // so these accounts skip it. Never stamp a verification we don't have.
          emailVerifiedAt: p.emailVerified ? new Date() : null,
        },
      });
    } catch (error) {
      if (!this.isPrismaError(error, 'P2002')) {
        this.logger.error(
          `Unexpected error creating user from Google sub ${p.sub}`,
          error instanceof Error ? error.stack : String(error),
        );
        throw error;
      }
      // Race: a concurrent sign-in (or a registration) claimed this sub/email
      // between our lookups and this insert. Read once more and resolve against
      // whoever won, instead of 500ing on the unique constraint.
      const winner = await this.findGoogleRaceWinner(p.sub, email);
      if (!winner) {
        this.logger.error(
          `Google sign-in for sub ${p.sub} hit a unique-constraint violation, but neither the sub nor ${email} resolves to a row`,
          error instanceof Error ? error.stack : String(error),
        );
        throw error;
      }
      return winner.googleSub === p.sub
        ? this.refreshGoogleProfile(winner, p, email)
        : this.linkGoogleIdentity(winner, p, email);
    }
  }

  /** Looks up a user by their unique email (email/password sign-in). */
  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  /**
   * Creates an email/password account (googleSub stays null). A duplicate email
   * maps to a clear conflict so the register flow can tell the user to sign in.
   */
  async createLocalUser(p: {
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<User> {
    try {
      return await this.prisma.user.create({
        data: {
          email: p.email,
          name: p.name,
          passwordHash: p.passwordHash,
        },
      });
    } catch (error) {
      if (this.isPrismaError(error, 'P2002')) {
        throw new ConflictException(
          'An account with this email already exists. Sign in instead.',
        );
      }
      this.logger.error(
        `Unexpected error creating local user for ${p.email}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  /** Sets (or replaces) a user's password hash — used by reset/change flows. */
  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
  }

  /**
   * Overwrites the name + password of an as-yet-unverified local account. Used
   * when someone re-registers an email whose OTP was never confirmed — ownership
   * was never proven, so the latest sign-up wins.
   */
  updateLocalCredentials(
    userId: string,
    p: { name: string; passwordHash: string },
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { name: p.name, passwordHash: p.passwordHash },
    });
  }

  /** Stamps an account as email-verified (idempotent). */
  async markEmailVerified(userId: string, at: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: at },
    });
  }

  getTrustedContacts(userId: string): Promise<TrustedContact[]> {
    return this.prisma.trustedContact.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * userIds of contacts that are linked app users AND have consented by adding
   * this user back. See {@link filterConsentingContactUserIds}.
   */
  async getContactUserIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.trustedContact.findMany({
      where: { userId, contactUserId: { not: null } },
      select: { contactUserId: true },
    });
    const candidates = rows
      .map((row) => row.contactUserId)
      .filter((id): id is string => id !== null);
    return this.filterConsentingContactUserIds(userId, candidates);
  }

  /**
   * Mutual-consent gate for notification fan-out. Anyone can *save* another
   * user's account as a trusted contact (by uuid), but we must never push an
   * SOS, live-trip share, or alert to that account unless they have also added
   * this user as one of their own trusted contacts. Without this, a stranger
   * who learns your user id could silently register to receive your live
   * location. Returns only the reciprocated ids (order not preserved).
   */
  async filterConsentingContactUserIds(
    ownerId: string,
    candidateUserIds: string[],
  ): Promise<string[]> {
    const unique = [...new Set(candidateUserIds)].filter(
      (id) => id !== ownerId,
    );
    if (unique.length === 0) return [];
    const reciprocals = await this.prisma.trustedContact.findMany({
      where: { userId: { in: unique }, contactUserId: ownerId },
      select: { userId: true },
    });
    const consented = new Set(reciprocals.map((r) => r.userId));
    return unique.filter((id) => consented.has(id));
  }

  // ── reputation ────────────────────────────────────────────────────────

  /**
   * Applies a BOUNDED reputation penalty in one atomic statement.
   *
   *   reputation = GREATEST(reputation + penalty, LEAST(reputation, floor))
   *
   * Read the inner `LEAST` carefully — it is the whole point. A naive
   * `GREATEST(reputation + penalty, floor)` would RAISE someone who is already
   * below the floor for other reasons (rejected reports go lower than any single
   * feature's floor), turning a punishment into a gift. `LEAST(reputation,
   * floor)` makes the clamp "never push them below the floor, and never move
   * them up": a user under the floor is simply left where they are.
   *
   * ONE STATEMENT, not read-modify-write: two concurrent penalties must both
   * land and neither may clobber the other's read. Postgres evaluates the
   * arithmetic and the clamp under the row lock the UPDATE already takes.
   *
   * WHO SHOULD CALL THIS: the caller owns "should this be charged at all?" and
   * must have already won an idempotency guard, because this method itself is
   * NOT idempotent — calling it twice charges twice, by design.
   *
   * @param penalty must be <= 0. A positive value would be a reward, and a
   * reward routed through a floor clamp is a bug, so it is refused loudly.
   * @param floor the lowest value this penalty may drive the user to.
   * @returns the reputation after the write, or null if the user no longer
   * exists (a deleted account is not an error worth failing a caller over).
   */
  async applyBoundedReputationPenalty(
    userId: string,
    penalty: number,
    floor: number,
  ): Promise<number | null> {
    if (penalty > 0) {
      throw new Error(
        `applyBoundedReputationPenalty received a positive delta (${penalty}) — it clamps against a floor and must never be used to award reputation.`,
      );
    }

    const rows = await this.prisma.$queryRaw<{ reputation: number }[]>`
      UPDATE "users"
      SET "reputation" = GREATEST(
        "reputation" + ${penalty}::int,
        LEAST("reputation", ${floor}::int)
      )
      WHERE "id" = ${userId}::uuid
      RETURNING "reputation"
    `;
    if (rows.length === 0) {
      this.logger.warn(
        `Reputation penalty of ${penalty} skipped — user ${userId} no longer exists`,
      );
      return null;
    }
    return rows[0].reputation;
  }

  // ── profile ───────────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<ProfileWithCounts> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        _count: {
          select: { trips: true, reports: true, trustedContacts: true },
        },
      },
    });
    if (!user) {
      throw new NotFoundException(
        'Your account could not be found — it may have been deleted. Please sign in again.',
      );
    }
    return {
      ...this.toProfile(user),
      counts: {
        trips: user._count.trips,
        reports: user._count.reports,
        contacts: user._count.trustedContacts,
      },
    };
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserProfile> {
    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl;
    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data,
      });
      return this.toProfile(user);
    } catch (error) {
      if (this.isPrismaError(error, 'P2025')) {
        throw new NotFoundException(
          'Your account could not be found — it may have been deleted. Please sign in again.',
        );
      }
      this.logger.error(
        `Unexpected error updating profile for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  /**
   * GDPR account deletion. A single prisma.user.delete is enough: the schema's
   * onDelete rules cascade to refresh tokens, trusted contacts, device tokens,
   * trips (with points/routes/watchers), reports, votes, alerts and SOS events.
   */
  async deleteAccount(userId: string): Promise<void> {
    try {
      await this.prisma.user.delete({ where: { id: userId } });
      // Erase precise last-known coordinates + online state from Redis too —
      // the Prisma cascade does not reach the shared geo:presence set.
      await this.redis.clearPresence(userId).catch((error: unknown) => {
        this.logger.error(
          `Account ${userId} deleted, but clearing Redis presence failed`,
          error instanceof Error ? error.stack : String(error),
        );
      });
      this.logger.log(
        `User ${userId} deleted their account (GDPR cascade delete)`,
      );
    } catch (error) {
      if (this.isPrismaError(error, 'P2025')) {
        throw new NotFoundException(
          'Your account was already deleted — there is nothing left to remove.',
        );
      }
      this.logger.error(
        `Unexpected error deleting account for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  // ── trusted contacts ──────────────────────────────────────────────────

  /**
   * EVERY contact, oldest first, as a flat array.
   *
   * DELIBERATELY NOT PAGINATED, and the shape is frozen. TestFlight builds that
   * are already on people's phones call `GET /me/contacts` and index straight
   * into the array; wrapping it in `{ data, page, … }` would break them in the
   * field, on the screen that arms the SOS feature. New fields may be ADDED to
   * each item (that is how `favorite` arrived) — the envelope may not change.
   * Anything that wants paging or search uses {@link listContactsPage}.
   */
  listContacts(userId: string): Promise<ContactWithLinkedUser[]> {
    return this.prisma.trustedContact.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: CONTACT_USER_SELECT,
    });
  }

  /**
   * One page of the caller's own contacts, optionally filtered by `q`.
   *
   * `q` is a case-insensitive substring of name OR email OR phone, because a
   * person searching their contact list types whichever of the three they
   * happen to remember — "mum", "@gmail", or the last four digits of a number.
   * Matching only `name` sends people to the empty state while the contact they
   * want is sitting three rows down.
   *
   * Partial matching is safe HERE and nowhere else: the `where` is anchored on
   * `userId`, so this only ever searches rows the caller already owns. The
   * account lookup in {@link lookupContactUserByEmail} stays exact-match for
   * exactly the reason this one need not be.
   *
   * `total` counts the whole filtered set, not this page, so the UI can render
   * "12 of 40" and decide whether a next page exists. Count and page come from
   * ONE transaction so they cannot disagree about a row added mid-request.
   */
  async listContactsPage(
    userId: string,
    query: ListContactsQueryDto,
  ): Promise<PaginatedContacts> {
    const page = query.page ?? 1;
    const limit = Math.min(
      query.limit ?? CONTACT_PAGE_DEFAULT_LIMIT,
      CONTACT_PAGE_MAX_LIMIT,
    );
    const q = query.q?.trim();
    const where: Prisma.TrustedContactWhereInput = {
      userId,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
              { phone: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.trustedContact.findMany({
        where,
        orderBy: [...CONTACT_PAGE_ORDER_BY],
        skip: (page - 1) * limit,
        take: limit,
        include: CONTACT_USER_SELECT,
      }),
      this.prisma.trustedContact.count({ where }),
    ]);

    // Same item shape as listContacts, so a client can move between the two
    // routes without a second mapper.
    return { data, page, limit, total };
  }

  /**
   * Resolves an EXACT email to the minimal public profile of a RoamWarden
   * account, so the app can link a trusted contact without a human ever pasting
   * a user id.
   *
   * This is an account-enumeration surface and is built as one:
   *
   *  - EXACT match only. `findUnique` on the normalised address — no prefix, no
   *    `contains`, no fuzzy fallback. You can confirm an address you already
   *    know; you can never browse for one.
   *  - Rate limited per ACCOUNT here (see {@link assertWithinLookupQuota}) and
   *    per IP by `@Throttle` on the route.
   *  - Returns id + name + avatar and nothing else, assembled field by field so
   *    a future widening of the select cannot leak through.
   *  - Answers "no account" as a normal 200 with a next step, so a miss is not
   *    dressed up as an error the app has to apologise for.
   *
   * CONFIRMING EXISTENCE IS THE DELIBERATE CHOICE. Secrecy is not what protects
   * this data: mutual consent is. Learning that ada@example.com has an account
   * grants exactly nothing — linking her does not show the caller her location,
   * nor hers to him, until she independently adds him back (see
   * {@link filterConsentingContactUserIds}, which every fan-out passes through).
   * The alternative — link blind to an address and hope — would be worse UX for
   * a safety feature and no safer, because the identical email/no-email signal
   * leaks anyway the moment alerts do or don't arrive.
   */
  async lookupContactUserByEmail(
    userId: string,
    email: string,
  ): Promise<ContactUserLookupResult> {
    // Counted BEFORE the query, so misses and self-lookups — exactly what a
    // scraper generates — spend budget too.
    await this.assertWithinLookupQuota(userId);

    const match = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: CONTACT_LOOKUP_SELECT,
    });

    if (!match) {
      // Deliberately no email in this log line: an audit trail of who searched
      // for whom would be a worse privacy leak than the endpoint itself.
      this.logger.log(`Contact lookup by user ${userId}: no match`);
      return {
        found: false,
        user: null,
        alreadyAdded: false,
        existingContactId: null,
        message: CONTACT_LOOKUP_NO_ACCOUNT,
      };
    }

    if (match.id === userId) {
      throw new BadRequestException({
        code: CONTACT_LOOKUP_SELF_CODE,
        message: CONTACT_LOOKUP_SELF,
      });
    }

    // The caller's OWN row, so this discloses nothing about the matched user —
    // and it stops the app collecting a name and a relation only to be told 409.
    const existing = await this.prisma.trustedContact.findUnique({
      where: { userId_contactUserId: { userId, contactUserId: match.id } },
      select: { id: true },
    });

    this.logger.log(`Contact lookup by user ${userId}: matched ${match.id}`);
    return {
      found: true,
      // Copied field by field on purpose — never spread a database row into a
      // response about someone who is not the caller.
      user: { id: match.id, name: match.name, avatarUrl: match.avatarUrl },
      alreadyAdded: existing !== null,
      existingContactId: existing?.id ?? null,
      message: existing
        ? contactLookupAlreadyAdded(match.name)
        : contactLookupFound(match.name),
    };
  }

  async createContact(
    userId: string,
    dto: CreateContactDto,
  ): Promise<ContactWithLinkedUser> {
    if (!dto.phone && !dto.email && !dto.contactUserId) {
      throw new BadRequestException(CONTACT_NEEDS_REACHABLE_FIELD);
    }
    if (dto.contactUserId) {
      await this.assertLinkableContactUser(userId, dto.contactUserId);
      const duplicate = await this.prisma.trustedContact.findUnique({
        where: {
          userId_contactUserId: { userId, contactUserId: dto.contactUserId },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new ConflictException(DUPLICATE_LINKED_CONTACT);
      }
    }
    try {
      return await this.prisma.trustedContact.create({
        data: {
          userId,
          name: dto.name,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          contactUserId: dto.contactUserId ?? null,
          relation: dto.relation ?? null,
        },
        include: CONTACT_USER_SELECT,
      });
    } catch (error) {
      // Race against a concurrent create with the same linked user.
      if (this.isPrismaError(error, 'P2002')) {
        throw new ConflictException(DUPLICATE_LINKED_CONTACT);
      }
      // Race against the linked user deleting their account.
      if (this.isPrismaError(error, 'P2003')) {
        throw new NotFoundException(LINKED_USER_NOT_FOUND);
      }
      this.logger.error(
        `Unexpected error creating trusted contact for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  async updateContact(
    userId: string,
    contactId: string,
    dto: UpdateContactDto,
  ): Promise<ContactWithLinkedUser> {
    const existing = await this.prisma.trustedContact.findFirst({
      where: { id: contactId, userId },
    });
    if (!existing) {
      throw new NotFoundException(CONTACT_NOT_FOUND);
    }

    // Re-check the "reachable somehow" rule against the merged result.
    const merged = {
      phone: dto.phone !== undefined ? dto.phone : existing.phone,
      email: dto.email !== undefined ? dto.email : existing.email,
      contactUserId:
        dto.contactUserId !== undefined
          ? dto.contactUserId
          : existing.contactUserId,
    };
    if (!merged.phone && !merged.email && !merged.contactUserId) {
      throw new BadRequestException(CONTACT_NEEDS_REACHABLE_FIELD);
    }

    if (
      merged.contactUserId &&
      merged.contactUserId !== existing.contactUserId
    ) {
      await this.assertLinkableContactUser(userId, merged.contactUserId);
      const duplicate = await this.prisma.trustedContact.findFirst({
        where: {
          userId,
          contactUserId: merged.contactUserId,
          id: { not: contactId },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new ConflictException(DUPLICATE_LINKED_CONTACT);
      }
    }

    const data: Prisma.TrustedContactUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.relation !== undefined) data.relation = dto.relation;
    if (dto.contactUserId !== undefined) data.contactUserId = dto.contactUserId;
    // A pure display preference — it deliberately skips the "reachable somehow"
    // re-check above, because favouriting cannot make a contact unreachable.
    if (dto.favorite !== undefined) data.favorite = dto.favorite;

    try {
      return await this.prisma.trustedContact.update({
        where: { id: contactId },
        data,
        include: CONTACT_USER_SELECT,
      });
    } catch (error) {
      if (this.isPrismaError(error, 'P2002')) {
        throw new ConflictException(DUPLICATE_LINKED_CONTACT);
      }
      if (this.isPrismaError(error, 'P2025')) {
        throw new NotFoundException(CONTACT_NOT_FOUND);
      }
      // Race: the account being linked deleted itself between the check above
      // and this write. Without this the user got a bare 500.
      if (this.isPrismaError(error, 'P2003')) {
        throw new NotFoundException(LINKED_USER_NOT_FOUND);
      }
      this.logger.error(
        `Unexpected error updating trusted contact ${contactId} for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  async deleteContact(userId: string, contactId: string): Promise<void> {
    const { count } = await this.prisma.trustedContact.deleteMany({
      where: { id: contactId, userId },
    });
    if (count === 0) {
      throw new NotFoundException(CONTACT_NOT_FOUND);
    }
  }

  // ── contact groups ────────────────────────────────────────────────────
  //
  // A contact group is the OWNER'S OWN LABEL over contacts they already have —
  // "Family", "Work". It is private to them and is NOT the family-plan Group in
  // src/resources/group: nobody joins one, nobody is invited to one, and nobody
  // is notified because of one. Grouping therefore grants no reach whatsoever;
  // every fan-out still passes through filterConsentingContactUserIds.
  //
  // Ownership is enforced on EVERY route by scoping the query to `userId`, and
  // a miss is a 404 with the same wording style as a deleted group — never a
  // 403, which would confirm that the id exists on somebody else's account.

  /** The caller's groups, favourites first. `q` filters on the group name. */
  async listContactGroups(
    userId: string,
    query: ListContactGroupsQueryDto = {},
  ): Promise<ContactGroupView[]> {
    const q = query.q?.trim();
    const groups = await this.prisma.contactGroup.findMany({
      where: {
        userId,
        ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: [...CONTACT_GROUP_ORDER_BY],
      include: CONTACT_GROUP_MEMBERS_INCLUDE,
    });
    return groups.map((group) => this.toContactGroupView(group));
  }

  /**
   * Creates a group and files the given contacts into it in ONE write, so a
   * failure half-way cannot leave a nameless group or an orphaned membership.
   */
  async createContactGroup(
    userId: string,
    dto: CreateContactGroupDto,
  ): Promise<ContactGroupView> {
    // The DTO already trims; repeated here so a service-level caller (tests,
    // future internal use) can never store a name with edge whitespace.
    const name = dto.name.trim();
    const contactIds = await this.assertOwnedContactIds(userId, dto.contactIds);
    await this.assertContactGroupNameFree(userId, name, null);

    try {
      const group = await this.prisma.contactGroup.create({
        data: {
          userId,
          name,
          favorite: dto.favorite ?? false,
          ...(contactIds.length > 0
            ? {
                members: {
                  create: contactIds.map((contactId) => ({ contactId })),
                },
              }
            : {}),
        },
        include: CONTACT_GROUP_MEMBERS_INCLUDE,
      });
      return this.toContactGroupView(group);
    } catch (error) {
      // Race against a concurrent create of the same name (double-tap, retry).
      // The pre-check above cannot win this one — UNIQUE(user_id, name) does.
      if (this.isPrismaError(error, 'P2002')) {
        throw new ConflictException(duplicateContactGroupName(name));
      }
      // Race: a contact was deleted between the ownership check and this write.
      if (this.isPrismaError(error, 'P2003')) {
        throw new BadRequestException(contactIdsNotYours(contactIds));
      }
      this.logger.error(
        `Unexpected error creating contact group for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  /**
   * Renames / re-favourites a group and, ONLY when `contactIds` is present,
   * replaces its entire membership.
   *
   * Present vs absent is the whole contract: `[]` empties the group, three ids
   * leave exactly those three, and omitting the field leaves membership alone.
   * That distinction is why the replacement is a delete-then-insert rather than
   * an upsert — the app can rename a group without having to re-send a roster
   * it may not have loaded, and cannot silently truncate one by forgetting to.
   *
   * The rewrite runs inside a transaction so the group is never observed with
   * its old members removed and its new ones not yet added.
   */
  async updateContactGroup(
    userId: string,
    groupId: string,
    dto: UpdateContactGroupDto,
  ): Promise<ContactGroupView> {
    const existing = await this.prisma.contactGroup.findFirst({
      where: { id: groupId, userId },
      select: { id: true, name: true },
    });
    if (!existing) {
      throw new NotFoundException(CONTACT_GROUP_NOT_FOUND);
    }

    const name = dto.name?.trim();
    if (name !== undefined && name !== existing.name) {
      await this.assertContactGroupNameFree(userId, name, groupId);
    }
    // null = "leave the membership alone"; an array = "this is the new one".
    const replacementIds =
      dto.contactIds === undefined
        ? null
        : await this.assertOwnedContactIds(userId, dto.contactIds);

    const data: Prisma.ContactGroupUncheckedUpdateInput = {};
    if (name !== undefined) data.name = name;
    if (dto.favorite !== undefined) data.favorite = dto.favorite;

    try {
      const group = await this.prisma.$transaction(async (tx) => {
        if (replacementIds !== null) {
          await tx.contactGroupMember.deleteMany({ where: { groupId } });
          if (replacementIds.length > 0) {
            await tx.contactGroupMember.createMany({
              data: replacementIds.map((contactId) => ({ groupId, contactId })),
            });
          }
        }
        // Last, so its `include` reads back the membership we just wrote.
        return tx.contactGroup.update({
          where: { id: groupId },
          data,
          include: CONTACT_GROUP_MEMBERS_INCLUDE,
        });
      });
      return this.toContactGroupView(group);
    } catch (error) {
      if (this.isPrismaError(error, 'P2002')) {
        throw new ConflictException(
          duplicateContactGroupName(name ?? existing.name),
        );
      }
      if (this.isPrismaError(error, 'P2025')) {
        throw new NotFoundException(CONTACT_GROUP_NOT_FOUND);
      }
      if (this.isPrismaError(error, 'P2003')) {
        throw new BadRequestException(contactIdsNotYours(replacementIds ?? []));
      }
      this.logger.error(
        `Unexpected error updating contact group ${groupId} for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  /**
   * Deletes the group. THE CONTACTS SURVIVE — the cascade runs from
   * `contact_groups` to `contact_group_members` and stops there, so tidying up
   * a label can never cost someone the trusted contacts their SOS depends on.
   *
   * Scoped by `userId` in the same statement as the delete, so another
   * account's id deletes nothing and gets the ordinary not-found message.
   */
  async deleteContactGroup(userId: string, groupId: string): Promise<void> {
    const { count } = await this.prisma.contactGroup.deleteMany({
      where: { id: groupId, userId },
    });
    if (count === 0) {
      throw new NotFoundException(CONTACT_GROUP_NOT_FOUND);
    }
  }

  // ── device tokens ─────────────────────────────────────────────────────

  /**
   * Upsert keyed on the token: a device that signs into a different account
   * must follow the new account, so we reassign userId and bump lastSeenAt.
   */
  async registerDevice(
    userId: string,
    dto: RegisterDeviceDto,
  ): Promise<Pick<DeviceToken, 'id' | 'token' | 'platform' | 'lastSeenAt'>> {
    const device = await this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      create: { userId, token: dto.token, platform: dto.platform },
      update: { userId, platform: dto.platform, lastSeenAt: new Date() },
    });
    return {
      id: device.id,
      token: device.token,
      platform: device.platform,
      lastSeenAt: device.lastSeenAt,
    };
  }

  /** Idempotent: deleting an unknown (or someone else's) token is a no-op. */
  async removeDevice(userId: string, token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { token, userId } });
  }

  // ── internals ─────────────────────────────────────────────────────────

  /** Existing Google account signing in again: refresh what Google now says. */
  private async refreshGoogleProfile(
    user: User,
    p: GoogleIdentity,
    email: string,
  ): Promise<User> {
    try {
      return await this.prisma.user.update({
        where: { id: user.id },
        data: {
          email,
          name: p.name,
          // undefined = Google sent no picture — keep whatever we have.
          avatarUrl: p.avatarUrl,
        },
      });
    } catch (error) {
      if (this.isPrismaError(error, 'P2002')) {
        // Google now reports an address that another RoamWarden row owns.
        throw new ConflictException(googleEmailLinkedElsewhere(email));
      }
      this.logger.error(
        `Unexpected error refreshing Google profile for user ${user.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  /**
   * Attaches a Google identity to an account that already owns this email —
   * normally one created with email + password.
   *
   * SECURITY: linking by email is only sound because Google has *verified* the
   * address. `emailVerified` is the ID token's `email_verified` claim; without
   * it, anyone able to mint a Google account carrying someone else's address
   * could walk into that person's password account. So we fail closed: no
   * claim, no link. A different non-null googleSub on the row is a genuine
   * conflict and never silently overwritten.
   */
  private async linkGoogleIdentity(
    existing: User,
    p: GoogleIdentity,
    email: string,
  ): Promise<User> {
    if (existing.googleSub && existing.googleSub !== p.sub) {
      throw new ConflictException(googleEmailLinkedElsewhere(email));
    }
    if (!p.emailVerified) {
      throw new UnauthorizedException(googleEmailNotVerified(email));
    }

    // PRE-HIJACKING DEFENCE. If this account never proved it owns the mailbox
    // (emailVerifiedAt is null) then its password was set by someone who merely
    // CLAIMED the address — the classic pre-hijacking setup, where an attacker
    // registers a password account on a victim's email and waits. Google has now
    // proven the mailbox belongs to whoever is signing in, so they are the owner
    // and the unproven password must not survive the link: keeping it would hand
    // the attacker a working credential on a freshly-verified account. A genuine
    // user who simply never verified pays one password reset, which they can
    // complete precisely because they do control the mailbox.
    const wasProven = existing.emailVerifiedAt !== null;

    try {
      const linked = await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          googleSub: p.sub,
          // Keep the name they chose at sign-up; only fill a blank avatar.
          avatarUrl: existing.avatarUrl ?? p.avatarUrl ?? null,
          // Google's verified assertion is the same proof our OTP flow demands.
          emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
          // Both methods keep working ONLY when the password was set on an
          // already-verified account; otherwise it is revoked (see above).
          ...(wasProven ? {} : { passwordHash: null }),
        },
      });
      this.logger.log(
        wasProven
          ? `Linked Google sign-in to verified account ${existing.id}`
          : `Linked Google sign-in to unverified account ${existing.id}; revoked its unproven password`,
      );
      return linked;
    } catch (error) {
      if (this.isPrismaError(error, 'P2002')) {
        // Another request linked this sub to a different row first.
        throw new ConflictException(googleEmailLinkedElsewhere(email));
      }
      this.logger.error(
        `Unexpected error linking Google sub to existing user ${existing.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  /** Single re-read after a P2002 race: whoever actually owns sub, else email. */
  private async findGoogleRaceWinner(
    sub: string,
    email: string,
  ): Promise<User | null> {
    const bySub = await this.prisma.user.findUnique({
      where: { googleSub: sub },
    });
    if (bySub) return bySub;
    return this.prisma.user.findUnique({ where: { email } });
  }

  /**
   * Per-ACCOUNT lookup budget, fixed window in Redis.
   *
   * The route's `@Throttle` only sees an IP, because the global ThrottlerGuard
   * is registered ahead of JwtAuthGuard and therefore runs before `req.user`
   * exists. That leaves rotating IPs as a free bypass, which is precisely how a
   * breached-email-list replay would be run — so the identity-aware half of the
   * limit lives here, where the caller is known.
   *
   * Fails OPEN when Redis is down (`incrementCounter` returns null), matching
   * the OTP send quota: a Redis blip must not stop people adding the contacts
   * that make the SOS features work, and the per-IP limit still applies.
   */
  private async assertWithinLookupQuota(userId: string): Promise<void> {
    const count = await this.redis.incrementCounter(
      contactLookupQuotaKey(userId),
      CONTACT_LOOKUP_WINDOW_S,
    );
    if (count !== null && count > CONTACT_LOOKUP_MAX_PER_WINDOW) {
      this.logger.warn(
        `User ${userId} exceeded the contact-lookup budget (${count} lookups in ${CONTACT_LOOKUP_WINDOW_S}s)`,
      );
      throw new ThrottlerException(CONTACT_LOOKUP_RATE_LIMITED);
    }
  }

  /**
   * Every id must be one of THIS caller's trusted contacts. Deduped, and the
   * rejection names the offending ids — mirrors the `watcherContactIds` check
   * in TripsService.createTrip, because to the app it is the same mistake: a
   * stale id left in a list picker.
   *
   * Returns the deduped ids so callers write them exactly once.
   */
  private async assertOwnedContactIds(
    userId: string,
    ids: string[] | undefined,
  ): Promise<string[]> {
    const contactIds = [...new Set(ids ?? [])];
    if (contactIds.length === 0) return [];
    const contacts = await this.prisma.trustedContact.findMany({
      where: { id: { in: contactIds }, userId },
      select: { id: true },
    });
    const foundIds = new Set(contacts.map((contact) => contact.id));
    const badIds = contactIds.filter((id) => !foundIds.has(id));
    if (badIds.length > 0) {
      // Anything not owned by the caller — including a real id on someone
      // else's account — lands here, so this never confirms that an id exists.
      throw new BadRequestException(contactIdsNotYours(badIds));
    }
    return contactIds;
  }

  /**
   * Refuses a group name the caller is already using. Matched
   * case-INSENSITIVELY even though the unique index is exact, because "family"
   * and "Family" are the same label to a human and two of them in a picker is
   * a bug report. `exceptGroupId` lets a rename keep its own name.
   *
   * A pre-check, not the guarantee: `UNIQUE(user_id, name)` is what actually
   * stops a concurrent double-create, and the P2002 handlers translate it.
   */
  private async assertContactGroupNameFree(
    userId: string,
    name: string,
    exceptGroupId: string | null,
  ): Promise<void> {
    const clash = await this.prisma.contactGroup.findFirst({
      where: {
        userId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptGroupId ? { id: { not: exceptGroupId } } : {}),
      },
      select: { name: true },
    });
    if (clash) {
      // Quotes the STORED name, so someone who typed "family" can see it
      // clashed with the "Family" they already have.
      throw new ConflictException(duplicateContactGroupName(clash.name));
    }
  }

  /** Group row → API shape. `memberCount` saves the UI reaching into an array. */
  private toContactGroupView(group: ContactGroupWithMembers): ContactGroupView {
    const contactIds = group.members.map((member) => member.contactId);
    return {
      id: group.id,
      name: group.name,
      favorite: group.favorite,
      memberCount: contactIds.length,
      contactIds,
      createdAt: group.createdAt,
    };
  }

  /** Linked contact must be a real user and not the owner themselves. */
  private async assertLinkableContactUser(
    userId: string,
    contactUserId: string,
  ): Promise<void> {
    if (contactUserId === userId) {
      throw new BadRequestException(CONTACT_SELF_LINK);
    }
    const linked = await this.prisma.user.findUnique({
      where: { id: contactUserId },
      select: { id: true },
    });
    if (!linked) {
      throw new NotFoundException(LINKED_USER_NOT_FOUND);
    }
  }

  /** Public profile shape — never exposes googleSub. */
  private toProfile(user: User): UserProfile {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      phone: user.phone,
      reputation: user.reputation,
      isAdmin: user.isAdmin,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private isPrismaError(error: unknown, code: string): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === code
    );
  }
}
