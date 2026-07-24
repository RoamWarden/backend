import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
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
} from './constant/users.constants';
import type {
  ContactWithLinkedUser,
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
   * Login upsert keyed on the immutable Google `sub`: first login creates the
   * user; later logins refresh email/name/avatarUrl from Google's profile.
   */
  async upsertFromGoogle(p: {
    sub: string;
    email: string;
    name: string;
    avatarUrl?: string;
  }): Promise<User> {
    const email = normalizeEmail(p.email);
    try {
      return await this.prisma.user.upsert({
        where: { googleSub: p.sub },
        create: {
          googleSub: p.sub,
          email,
          name: p.name,
          avatarUrl: p.avatarUrl ?? null,
          // Google asserts the email is verified, so these accounts skip OTP.
          emailVerifiedAt: new Date(),
        },
        update: {
          email,
          name: p.name,
          // undefined = Google sent no picture — keep whatever we have.
          avatarUrl: p.avatarUrl,
        },
      });
    } catch (error) {
      if (this.isPrismaError(error, 'P2002')) {
        // The unique email already belongs to a row with a different googleSub.
        throw new ConflictException(
          `The email ${email} is already registered to a different RoamWarden account. Sign in with the Google account you originally used, or contact support.`,
        );
      }
      this.logger.error(
        `Unexpected error upserting user from Google sub ${p.sub}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
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
