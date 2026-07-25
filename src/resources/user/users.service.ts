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
import type { RegisterDeviceDto } from './dto/register-device.dto';
import type { UpdateContactDto } from './dto/update-contact.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import {
  CONTACT_NEEDS_REACHABLE_FIELD,
  CONTACT_NOT_FOUND,
  CONTACT_USER_SELECT,
  DUPLICATE_LINKED_CONTACT,
  googleEmailLinkedElsewhere,
  googleEmailNotVerified,
} from './constant/users.constants';
import type {
  ContactWithLinkedUser,
  GoogleIdentity,
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
   *  3. Email is free → create a fresh Google account.
   *
   * Only a *different, non-null* googleSub on that email is a real conflict.
   */
  async upsertFromGoogle(p: GoogleIdentity): Promise<User> {
    const email = normalizeEmail(p.email);

    const bySub = await this.prisma.user.findUnique({
      where: { googleSub: p.sub },
    });
    if (bySub) return this.refreshGoogleProfile(bySub, p, email);

    const byEmail = await this.prisma.user.findUnique({ where: { email } });
    if (byEmail) return this.linkGoogleIdentity(byEmail, p, email);

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

  listContacts(userId: string): Promise<ContactWithLinkedUser[]> {
    return this.prisma.trustedContact.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: CONTACT_USER_SELECT,
    });
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
        throw new NotFoundException(
          `No RoamWarden user exists with id ${dto.contactUserId}. Double-check the id, or omit contactUserId to save an unlinked contact.`,
        );
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

  /** Linked contact must be a real user and not the owner themselves. */
  private async assertLinkableContactUser(
    userId: string,
    contactUserId: string,
  ): Promise<void> {
    if (contactUserId === userId) {
      throw new BadRequestException(
        "You can't add yourself as your own trusted contact. Link a different RoamWarden user, or omit contactUserId.",
      );
    }
    const linked = await this.prisma.user.findUnique({
      where: { id: contactUserId },
      select: { id: true },
    });
    if (!linked) {
      throw new NotFoundException(
        `No RoamWarden user exists with id ${contactUserId}. Double-check the id, or omit contactUserId to save an unlinked contact.`,
      );
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
