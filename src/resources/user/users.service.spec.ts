import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { DevicePlatform, Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../providers/redis/redis.service';
import type { CreateContactDto } from './dto/create-contact.dto';
import type { CreateContactGroupDto } from './dto/create-contact-group.dto';
import type { RegisterDeviceDto } from './dto/register-device.dto';
import type { UpdateContactDto } from './dto/update-contact.dto';
import type { UpdateContactGroupDto } from './dto/update-contact-group.dto';
import {
  CONTACT_GROUP_MEMBERS_INCLUDE,
  CONTACT_GROUP_NOT_FOUND,
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
import type { GoogleIdentity } from './type/users.types';

/** Build a real Prisma known-request error so `instanceof` checks match. */
const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, {
    code,
    clientVersion: '6.0.0',
  });

/** Typed reader for the first argument of the first call to a jest mock. */
const firstArg = <T>(mock: jest.Mock): T => {
  const calls = mock.mock.calls as unknown as T[][];
  return calls[0][0];
};

/** `expect.any(Date)` typed as Date so it fits inside typed matcher literals. */
const ANY_DATE = expect.any(Date) as unknown as Date;

describe('UsersService', () => {
  let service: UsersService;
  let prismaMock: {
    user: {
      findUnique: jest.Mock;
      create: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    trustedContact: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
      count: jest.Mock;
    };
    contactGroup: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
    contactGroupMember: {
      createMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    deviceToken: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
    };
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };
  let redisMock: { clearPresence: jest.Mock; incrementCounter: jest.Mock };

  beforeEach(async () => {
    prismaMock = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      trustedContact: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      contactGroup: {
        findMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      contactGroupMember: {
        createMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      deviceToken: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ reputation: 0 }]),
      // Two call shapes, both real: the CALLBACK form runs against the same
      // mock so tx-based code paths work, and the ARRAY form resolves what it
      // was handed so batched reads (page + count) behave like the client's.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prismaMock)
          : Promise.all(arg as Promise<unknown>[]),
      ),
    };
    redisMock = {
      clearPresence: jest.fn().mockResolvedValue(undefined),
      // Default: first lookup of the window, i.e. well within the budget.
      incrementCounter: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: RedisService, useValue: redisMock },
      ],
    }).compile();

    service = module.get(UsersService);
    // Silence the service logger so error-path tests don't spam the output.
    const { logger } = service as unknown as {
      logger: { error: jest.Mock; log: jest.Mock; warn: jest.Mock };
    };
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  // ── findById ────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('delegates to prisma.user.findUnique by id', async () => {
      const user = { id: 'u1' };
      prismaMock.user.findUnique.mockResolvedValue(user);
      await expect(service.findById('u1')).resolves.toBe(user);
      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
      });
    });
  });

  // ── filterConsentingContactUserIds (mutual-consent privacy gate) ─────────

  describe('filterConsentingContactUserIds', () => {
    it('returns [] for empty input without querying prisma', async () => {
      await expect(
        service.filterConsentingContactUserIds('owner', []),
      ).resolves.toEqual([]);
      expect(prismaMock.trustedContact.findMany).not.toHaveBeenCalled();
    });

    it('EXCLUDES a non-reciprocating candidate and INCLUDES a reciprocating one', async () => {
      // Only "mutual" has added owner back; "stranger" has not.
      prismaMock.trustedContact.findMany.mockResolvedValue([
        { userId: 'mutual' },
      ]);

      const result = await service.filterConsentingContactUserIds('owner', [
        'mutual',
        'stranger',
      ]);

      expect(result).toEqual(['mutual']);
      expect(result).not.toContain('stranger');
      // The reciprocal lookup asks for rows where the candidate added owner back.
      expect(prismaMock.trustedContact.findMany).toHaveBeenCalledWith({
        where: {
          userId: { in: ['mutual', 'stranger'] },
          contactUserId: 'owner',
        },
        select: { userId: true },
      });
    });

    it("excludes the owner's own id even when it appears in candidates", async () => {
      // After stripping owner, only "friend" remains to be queried.
      prismaMock.trustedContact.findMany.mockResolvedValue([
        { userId: 'friend' },
      ]);

      const result = await service.filterConsentingContactUserIds('owner', [
        'owner',
        'friend',
      ]);

      expect(result).toEqual(['friend']);
      expect(result).not.toContain('owner');
      expect(prismaMock.trustedContact.findMany).toHaveBeenCalledWith({
        where: { userId: { in: ['friend'] }, contactUserId: 'owner' },
        select: { userId: true },
      });
    });

    it('dedups candidate ids before querying and in the result', async () => {
      prismaMock.trustedContact.findMany.mockResolvedValue([
        { userId: 'mutual' },
      ]);

      const result = await service.filterConsentingContactUserIds('owner', [
        'mutual',
        'mutual',
      ]);

      expect(result).toEqual(['mutual']);
      expect(prismaMock.trustedContact.findMany).toHaveBeenCalledWith({
        where: { userId: { in: ['mutual'] }, contactUserId: 'owner' },
        select: { userId: true },
      });
    });

    it('returns [] when only the owner id is supplied (nothing left to query)', async () => {
      await expect(
        service.filterConsentingContactUserIds('owner', ['owner', 'owner']),
      ).resolves.toEqual([]);
      expect(prismaMock.trustedContact.findMany).not.toHaveBeenCalled();
    });
  });

  // ── getContactUserIds (applies the gate) ─────────────────────────────────

  describe('getContactUserIds', () => {
    it('returns only reciprocated linked contacts (gate applied)', async () => {
      // First call: linked contactUserIds saved by owner.
      prismaMock.trustedContact.findMany
        .mockResolvedValueOnce([
          { contactUserId: 'mutual' },
          { contactUserId: 'stranger' },
          { contactUserId: null },
        ])
        // Second call: only "mutual" reciprocated.
        .mockResolvedValueOnce([{ userId: 'mutual' }]);

      const result = await service.getContactUserIds('owner');

      expect(result).toEqual(['mutual']);
      // First query filters to linked contacts only.
      expect(prismaMock.trustedContact.findMany).toHaveBeenNthCalledWith(1, {
        where: { userId: 'owner', contactUserId: { not: null } },
        select: { contactUserId: true },
      });
      // Second query is the reciprocity gate over the non-null candidates.
      expect(prismaMock.trustedContact.findMany).toHaveBeenNthCalledWith(2, {
        where: {
          userId: { in: ['mutual', 'stranger'] },
          contactUserId: 'owner',
        },
        select: { userId: true },
      });
    });

    it('returns [] when the user has no linked contacts', async () => {
      prismaMock.trustedContact.findMany.mockResolvedValueOnce([]);
      await expect(service.getContactUserIds('owner')).resolves.toEqual([]);
      // Gate short-circuits on empty input, so no second query.
      expect(prismaMock.trustedContact.findMany).toHaveBeenCalledTimes(1);
    });
  });

  // ── upsertFromGoogle ─────────────────────────────────────────────────────

  describe('upsertFromGoogle', () => {
    /** A verified Google identity — the only kind our verifier hands over. */
    const identity = (over: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
      sub: 'sub-123',
      email: 'ada@b.com',
      name: 'Ada',
      emailVerified: true,
      ...over,
    });

    /** Nobody owns the sub, nobody owns the email. */
    const noExistingUser = () =>
      prismaMock.user.findUnique
        .mockResolvedValueOnce(null) // by googleSub
        .mockResolvedValueOnce(null); // by email

    it('creates a pre-verified account for a brand-new Google user', async () => {
      const created = { id: 'u1', email: 'ada@b.com' };
      noExistingUser();
      prismaMock.user.create.mockResolvedValue(created);

      const result = await service.upsertFromGoogle(
        identity({
          email: 'Ada@B.com', // mixed case — must be stored lowercased
          avatarUrl: 'http://img/a.png',
        }),
      );

      expect(result).toBe(created);
      expect(prismaMock.user.findUnique).toHaveBeenNthCalledWith(1, {
        where: { googleSub: 'sub-123' },
      });
      expect(prismaMock.user.findUnique).toHaveBeenNthCalledWith(2, {
        where: { email: 'ada@b.com' },
      });
      const arg = firstArg<Prisma.UserCreateArgs>(prismaMock.user.create);
      expect(arg.data).toEqual({
        googleSub: 'sub-123',
        email: 'ada@b.com',
        name: 'Ada',
        avatarUrl: 'http://img/a.png',
        // Google asserts the email is verified, so the account is pre-verified.
        emailVerifiedAt: ANY_DATE,
      });
    });

    it('coerces a missing avatarUrl to null on create', async () => {
      noExistingUser();
      prismaMock.user.create.mockResolvedValue({ id: 'u1' });

      await service.upsertFromGoogle(identity());

      const arg = firstArg<Prisma.UserCreateArgs>(prismaMock.user.create);
      expect(arg.data.avatarUrl).toBeNull();
    });

    it('never pre-verifies a new account Google would not vouch for', async () => {
      noExistingUser();
      prismaMock.user.create.mockResolvedValue({ id: 'u1' });

      await service.upsertFromGoogle(identity({ emailVerified: false }));

      const arg = firstArg<Prisma.UserCreateArgs>(prismaMock.user.create);
      expect(arg.data.emailVerifiedAt).toBeNull();
    });

    it('signs an existing Google user in and refreshes their profile', async () => {
      const existing = { id: 'u1', googleSub: 'sub-123', email: 'old@b.com' };
      const refreshed = { id: 'u1', googleSub: 'sub-123', email: 'ada@b.com' };
      prismaMock.user.findUnique.mockResolvedValueOnce(existing);
      prismaMock.user.update.mockResolvedValue(refreshed);

      const result = await service.upsertFromGoogle(
        identity({ email: 'Ada@B.com', name: 'Ada Lovelace' }),
      );

      expect(result).toBe(refreshed);
      // Matching sub short-circuits: no email lookup, no create.
      expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prismaMock.user.create).not.toHaveBeenCalled();
      const arg = firstArg<Prisma.UserUpdateArgs>(prismaMock.user.update);
      expect(arg.where).toEqual({ id: 'u1' });
      expect(arg.data).toEqual({
        email: 'ada@b.com',
        name: 'Ada Lovelace',
        avatarUrl: undefined, // Google sent no picture — keep what we have.
      });
    });

    // ── the reported bug: password account + Google sign-in ─────────────────

    it('LINKS the Google identity onto an existing password account and keeps the password', async () => {
      const passwordAccount = {
        id: 'u1',
        email: 'ada@b.com',
        googleSub: null,
        passwordHash: 'argon2-hash',
        emailVerifiedAt: null,
        avatarUrl: null,
        name: 'Ada',
      };
      const linked = { ...passwordAccount, googleSub: 'sub-123' };
      prismaMock.user.findUnique
        .mockResolvedValueOnce(null) // no account owns this sub yet
        .mockResolvedValueOnce(passwordAccount);
      prismaMock.user.update.mockResolvedValue(linked);

      const result = await service.upsertFromGoogle(
        identity({ avatarUrl: 'http://img/a.png' }),
      );

      expect(result).toBe(linked);
      expect(prismaMock.user.create).not.toHaveBeenCalled();
      const arg = firstArg<Prisma.UserUpdateArgs>(prismaMock.user.update);
      expect(arg.where).toEqual({ id: 'u1' });
      expect(arg.data).toEqual({
        googleSub: 'sub-123',
        avatarUrl: 'http://img/a.png', // had none — fill it from Google
        // Google's verified assertion stands in for the OTP they never entered.
        emailVerifiedAt: ANY_DATE,
        // PRE-HIJACKING DEFENCE: this account never proved it owned the mailbox
        // (emailVerifiedAt was null), so its password was set by someone who only
        // CLAIMED the address. Google has now proven who really owns it, so that
        // unproven credential must NOT survive the link — otherwise an attacker
        // who registered on the victim's email first would keep a working
        // password on a freshly-verified account.
        passwordHash: null,
      });
    });

    it('KEEPS the password when linking to an account that had already verified its email', async () => {
      const alreadyVerified = new Date('2026-07-01T00:00:00.000Z');
      const verifiedAccount = {
        id: 'u1',
        email: 'ada@b.com',
        googleSub: null,
        passwordHash: 'argon2-hash',
        emailVerifiedAt: alreadyVerified,
        avatarUrl: null,
        name: 'Ada',
      };
      prismaMock.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(verifiedAccount);
      prismaMock.user.update.mockResolvedValue({
        ...verifiedAccount,
        googleSub: 'sub-123',
      });

      await service.upsertFromGoogle(identity());

      const arg = firstArg<Prisma.UserUpdateArgs>(prismaMock.user.update);
      // This user completed the OTP flow, so they demonstrably control the
      // mailbox: both sign-in methods are legitimately theirs and must keep
      // working. Only an UNPROVEN password is revoked.
      expect(arg.data).not.toHaveProperty('passwordHash');
      expect(arg.data.emailVerifiedAt).toEqual(alreadyVerified);
    });

    it('keeps the account name, existing avatar and original verification date when linking', async () => {
      const verifiedAt = new Date('2026-01-01T00:00:00.000Z');
      prismaMock.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'u1',
          email: 'ada@b.com',
          googleSub: null,
          passwordHash: 'argon2-hash',
          emailVerifiedAt: verifiedAt,
          avatarUrl: 'http://img/mine.png',
          name: 'Ada from sign-up',
        });
      prismaMock.user.update.mockResolvedValue({ id: 'u1' });

      await service.upsertFromGoogle(
        identity({
          name: 'Google Display Name',
          avatarUrl: 'http://img/g.png',
        }),
      );

      const arg = firstArg<Prisma.UserUpdateArgs>(prismaMock.user.update);
      expect(arg.data).toEqual({
        googleSub: 'sub-123',
        avatarUrl: 'http://img/mine.png',
        emailVerifiedAt: verifiedAt,
      });
      expect(arg.data).not.toHaveProperty('name');
    });

    it('REFUSES to link when Google has not verified the email (account takeover guard)', async () => {
      const passwordAccount = {
        id: 'u1',
        email: 'victim@b.com',
        googleSub: null,
        passwordHash: 'argon2-hash',
        emailVerifiedAt: null,
        avatarUrl: null,
      };
      prismaMock.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(passwordAccount);

      await expect(
        service.upsertFromGoogle(
          identity({ email: 'victim@b.com', emailVerified: false }),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prismaMock.user.update).not.toHaveBeenCalled();
      expect(prismaMock.user.create).not.toHaveBeenCalled();
    });

    it('explains the unverified-email refusal in human terms', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'u1', googleSub: null });

      await expect(
        service.upsertFromGoogle(
          identity({ email: 'victim@b.com', emailVerified: false }),
        ),
      ).rejects.toThrow(googleEmailNotVerified('victim@b.com'));
    });

    it('still conflicts when the email belongs to a DIFFERENT Google account', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'u1', googleSub: 'someone-else' });

      await expect(
        service.upsertFromGoogle(identity({ email: 'taken@b.com' })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('gives the different-Google-account conflict a human message', async () => {
      prismaMock.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'u1', googleSub: 'someone-else' });

      await expect(
        service.upsertFromGoogle(identity({ email: 'taken@b.com' })),
      ).rejects.toThrow(googleEmailLinkedElsewhere('taken@b.com'));
    });

    // ── concurrency ─────────────────────────────────────────────────────────

    it('retries the lookup once when a concurrent request wins the create race, then links', async () => {
      const passwordAccount = {
        id: 'u1',
        email: 'ada@b.com',
        googleSub: null,
        passwordHash: 'argon2-hash',
        emailVerifiedAt: null,
        avatarUrl: null,
      };
      const linked = { ...passwordAccount, googleSub: 'sub-123' };
      prismaMock.user.findUnique
        .mockResolvedValueOnce(null) // 1st pass: no sub
        .mockResolvedValueOnce(null) // 1st pass: no email
        .mockResolvedValueOnce(null) // retry: still no sub
        .mockResolvedValueOnce(passwordAccount); // retry: the winner's row
      prismaMock.user.create.mockRejectedValue(prismaError('P2002'));
      prismaMock.user.update.mockResolvedValue(linked);

      await expect(service.upsertFromGoogle(identity())).resolves.toBe(linked);

      expect(prismaMock.user.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(4);
      const arg = firstArg<Prisma.UserUpdateArgs>(prismaMock.user.update);
      expect(arg.data).toMatchObject({ googleSub: 'sub-123' });
    });

    it('returns the row a concurrent identical sign-in created (same sub wins the race)', async () => {
      const winner = { id: 'u1', googleSub: 'sub-123', email: 'ada@b.com' };
      prismaMock.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner); // retry: the sub now exists
      prismaMock.user.create.mockRejectedValue(prismaError('P2002'));
      prismaMock.user.update.mockResolvedValue(winner);

      await expect(service.upsertFromGoogle(identity())).resolves.toBe(winner);
      const arg = firstArg<Prisma.UserUpdateArgs>(prismaMock.user.update);
      expect(arg.where).toEqual({ id: 'u1' });
    });

    it('rethrows the P2002 when the retry finds no owner at all (no silent loop)', async () => {
      const conflict = prismaError('P2002');
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.create.mockRejectedValue(conflict);

      await expect(service.upsertFromGoogle(identity())).rejects.toBe(conflict);
      expect(prismaMock.user.create).toHaveBeenCalledTimes(1);
    });

    it('rethrows unexpected create errors unchanged', async () => {
      const boom = new Error('db exploded');
      noExistingUser();
      prismaMock.user.create.mockRejectedValue(boom);

      await expect(service.upsertFromGoogle(identity())).rejects.toBe(boom);
    });

    it('maps a P2002 while refreshing an existing Google profile to a conflict', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'u1',
        googleSub: 'sub-123',
      });
      prismaMock.user.update.mockRejectedValue(prismaError('P2002'));

      await expect(
        service.upsertFromGoogle(identity({ email: 'taken@b.com' })),
      ).rejects.toThrow(googleEmailLinkedElsewhere('taken@b.com'));
    });

    // ── login-only mode (the website) ────────────────────────────────────────
    //
    // The web must never mint an account: accounts are built in the app, where
    // the email is verified, the push token registered and trusted contacts
    // added. Signing IN — including linking onto a password account — is
    // unchanged; only creation is off.

    describe('allowSignup', () => {
      it('creates a brand-new account when the caller passes no options (app behaviour)', async () => {
        noExistingUser();
        prismaMock.user.create.mockResolvedValue({ id: 'u1' });

        await expect(service.upsertFromGoogle(identity())).resolves.toEqual({
          id: 'u1',
        });
        expect(prismaMock.user.create).toHaveBeenCalledTimes(1);
      });

      it('creates a brand-new account when allowSignup is explicitly true', async () => {
        noExistingUser();
        prismaMock.user.create.mockResolvedValue({ id: 'u1' });

        await expect(
          service.upsertFromGoogle(identity(), { allowSignup: true }),
        ).resolves.toEqual({ id: 'u1' });
        expect(prismaMock.user.create).toHaveBeenCalledTimes(1);
      });

      it('allowSignup:false + unknown identity writes NOTHING and throws NO_ACCOUNT', async () => {
        noExistingUser();

        const err = await service
          .upsertFromGoogle(identity({ email: 'Ada@B.com' }), {
            allowSignup: false,
          })
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(NotFoundException);
        // Machine-readable code + a human sentence, exactly like the login
        // flow's EMAIL_NOT_VERIFIED. Never a bare 401: the web reads that as a
        // dead session and would loop through refresh/redirect.
        expect((err as NotFoundException).getResponse()).toEqual({
          code: GOOGLE_NO_ACCOUNT_CODE,
          message: googleNoAccount('ada@b.com'),
        });
        expect((err as NotFoundException).getStatus()).toBe(404);
        // Both lookups ran, then it stopped — no row created or touched.
        expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(2);
        expect(prismaMock.user.create).not.toHaveBeenCalled();
        expect(prismaMock.user.update).not.toHaveBeenCalled();
      });

      it('allowSignup:false signs in an existing Google user', async () => {
        const existing = { id: 'u1', googleSub: 'sub-123', email: 'old@b.com' };
        const refreshed = { ...existing, email: 'ada@b.com' };
        prismaMock.user.findUnique.mockResolvedValueOnce(existing);
        prismaMock.user.update.mockResolvedValue(refreshed);

        await expect(
          service.upsertFromGoogle(identity(), { allowSignup: false }),
        ).resolves.toBe(refreshed);
        expect(prismaMock.user.create).not.toHaveBeenCalled();
      });

      it('allowSignup:false LINKS an existing password account and signs it in', async () => {
        const verifiedAt = new Date('2026-01-01T00:00:00.000Z');
        const passwordAccount = {
          id: 'u1',
          email: 'ada@b.com',
          googleSub: null,
          passwordHash: 'argon2-hash',
          emailVerifiedAt: verifiedAt,
          avatarUrl: null,
          name: 'Ada',
        };
        const linked = { ...passwordAccount, googleSub: 'sub-123' };
        prismaMock.user.findUnique
          .mockResolvedValueOnce(null) // nobody owns the sub
          .mockResolvedValueOnce(passwordAccount); // …but the email exists
        prismaMock.user.update.mockResolvedValue(linked);

        await expect(
          service.upsertFromGoogle(identity(), { allowSignup: false }),
        ).resolves.toBe(linked);

        // Matching an existing account is a SIGN-IN, not a sign-up.
        expect(prismaMock.user.create).not.toHaveBeenCalled();
        const arg = firstArg<Prisma.UserUpdateArgs>(prismaMock.user.update);
        expect(arg.where).toEqual({ id: 'u1' });
        expect(arg.data).toMatchObject({ googleSub: 'sub-123' });
        // Verified account → its password survives the link, as before.
        expect(arg.data).not.toHaveProperty('passwordHash');
      });

      it('allowSignup:false keeps the email_verified gate when linking', async () => {
        prismaMock.user.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'u1', googleSub: null });

        await expect(
          service.upsertFromGoogle(
            identity({ email: 'victim@b.com', emailVerified: false }),
            { allowSignup: false },
          ),
        ).rejects.toThrow(googleEmailNotVerified('victim@b.com'));
        expect(prismaMock.user.update).not.toHaveBeenCalled();
        expect(prismaMock.user.create).not.toHaveBeenCalled();
      });

      it('allowSignup:false still revokes an UNPROVEN password when linking', async () => {
        const unverifiedAccount = {
          id: 'u1',
          email: 'ada@b.com',
          googleSub: null,
          passwordHash: 'argon2-hash',
          emailVerifiedAt: null,
          avatarUrl: null,
          name: 'Ada',
        };
        prismaMock.user.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(unverifiedAccount);
        prismaMock.user.update.mockResolvedValue({ id: 'u1' });

        await service.upsertFromGoogle(identity(), { allowSignup: false });

        const arg = firstArg<Prisma.UserUpdateArgs>(prismaMock.user.update);
        // Pre-hijacking defence is untouched by login-only mode.
        expect(arg.data.passwordHash).toBeNull();
      });
    });
  });

  // ── deleteAccount ────────────────────────────────────────────────────────

  describe('deleteAccount', () => {
    it('deletes the user then clears Redis presence', async () => {
      prismaMock.user.delete.mockResolvedValue({ id: 'u1' });

      await expect(service.deleteAccount('u1')).resolves.toBeUndefined();

      expect(prismaMock.user.delete).toHaveBeenCalledWith({
        where: { id: 'u1' },
      });
      expect(redisMock.clearPresence).toHaveBeenCalledWith('u1');
    });

    it('still resolves when clearPresence rejects (Redis hiccup is swallowed)', async () => {
      prismaMock.user.delete.mockResolvedValue({ id: 'u1' });
      redisMock.clearPresence.mockRejectedValue(new Error('redis down'));

      // Account deletion must not fail on a Redis hiccup.
      await expect(service.deleteAccount('u1')).resolves.toBeUndefined();
      expect(prismaMock.user.delete).toHaveBeenCalledWith({
        where: { id: 'u1' },
      });
    });

    it('maps P2025 (already deleted) to NotFoundException and skips clearPresence', async () => {
      prismaMock.user.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.deleteAccount('u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.deleteAccount('u1')).rejects.toThrow(
        /Your account was already deleted/,
      );
      expect(redisMock.clearPresence).not.toHaveBeenCalled();
    });

    it('rethrows unexpected delete errors', async () => {
      const boom = new Error('constraint blew up');
      prismaMock.user.delete.mockRejectedValue(boom);
      await expect(service.deleteAccount('u1')).rejects.toBe(boom);
    });
  });

  // ── lookupContactUserByEmail (account-enumeration surface) ───────────────

  describe('lookupContactUserByEmail', () => {
    /** A row as prisma returns it for CONTACT_LOOKUP_SELECT. */
    const friend = { id: 'friend', name: 'Ada Lovelace', avatarUrl: null };

    it('resolves an EXACT normalised email to the minimal public profile', async () => {
      prismaMock.user.findUnique.mockResolvedValue(friend);
      prismaMock.trustedContact.findUnique.mockResolvedValue(null);

      const result = await service.lookupContactUserByEmail(
        'u1',
        'ada@example.com',
      );

      expect(result).toEqual({
        found: true,
        user: { id: 'friend', name: 'Ada Lovelace', avatarUrl: null },
        alreadyAdded: false,
        existingContactId: null,
        message: contactLookupFound('Ada Lovelace'),
      });
      // findUnique on the unique column — never a `contains`/`startsWith` query.
      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'ada@example.com' },
        select: CONTACT_LOOKUP_SELECT,
      });
    });

    it('matches regardless of case and surrounding whitespace', async () => {
      prismaMock.user.findUnique.mockResolvedValue(friend);
      prismaMock.trustedContact.findUnique.mockResolvedValue(null);

      await service.lookupContactUserByEmail('u1', '  AdA@Example.COM  ');

      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'ada@example.com' },
        select: CONTACT_LOOKUP_SELECT,
      });
    });

    it('selects ONLY id, name and avatarUrl — the enumeration budget of this endpoint', () => {
      expect(Object.keys(CONTACT_LOOKUP_SELECT)).toEqual([
        'id',
        'name',
        'avatarUrl',
      ]);
    });

    it('never leaks email, phone, reputation or counts, even if the row carries them', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...friend,
        email: 'ada@example.com',
        phone: '+15551234567',
        reputation: 42,
        passwordHash: 'hash',
        googleSub: 'sub-123',
      });
      prismaMock.trustedContact.findUnique.mockResolvedValue(null);

      const result = await service.lookupContactUserByEmail(
        'u1',
        'ada@example.com',
      );

      expect(result.user).not.toBeNull();
      expect(Object.keys(result.user ?? {})).toEqual([
        'id',
        'name',
        'avatarUrl',
      ]);
      const body = JSON.stringify(result);
      expect(body).not.toContain('ada@example.com');
      expect(body).not.toContain('+15551234567');
      expect(body).not.toContain('reputation');
      expect(body).not.toContain('hash');
      expect(body).not.toContain('sub-123');
    });

    it('treats "no account with that email" as a normal 200 outcome with a next step', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      const result = await service.lookupContactUserByEmail(
        'u1',
        'nobody@example.com',
      );

      expect(result).toEqual({
        found: false,
        user: null,
        alreadyAdded: false,
        existingContactId: null,
        message: CONTACT_LOOKUP_NO_ACCOUNT,
      });
      expect(result.message).toMatch(/you can still save them as a contact/i);
      // A miss must not cost a second query about the caller's contacts.
      expect(prismaMock.trustedContact.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a self-lookup with a clear message and a branchable code', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        name: 'Me',
        avatarUrl: null,
      });

      const error: unknown = await service
        .lookupContactUserByEmail('u1', 'me@example.com')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual({
        code: CONTACT_LOOKUP_SELF_CODE,
        message: CONTACT_LOOKUP_SELF,
      });
      expect(CONTACT_LOOKUP_SELF).toMatch(/your own account/i);
      expect(prismaMock.trustedContact.findUnique).not.toHaveBeenCalled();
    });

    it('reports when the match is already a contact, so the app never dead-ends on a 409', async () => {
      prismaMock.user.findUnique.mockResolvedValue(friend);
      prismaMock.trustedContact.findUnique.mockResolvedValue({ id: 'c9' });

      const result = await service.lookupContactUserByEmail(
        'u1',
        'ada@example.com',
      );

      expect(result).toEqual({
        found: true,
        user: friend,
        alreadyAdded: true,
        existingContactId: 'c9',
        message: contactLookupAlreadyAdded('Ada Lovelace'),
      });
      expect(prismaMock.trustedContact.findUnique).toHaveBeenCalledWith({
        where: {
          userId_contactUserId: { userId: 'u1', contactUserId: 'friend' },
        },
        select: { id: true },
      });
    });

    // ── per-account rate limit ────────────────────────────────────────────

    it('counts every lookup against a per-account window BEFORE querying', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await service.lookupContactUserByEmail('u1', 'nobody@example.com');

      expect(redisMock.incrementCounter).toHaveBeenCalledWith(
        contactLookupQuotaKey('u1'),
        CONTACT_LOOKUP_WINDOW_S,
      );
    });

    it('allows the last lookup inside the budget', async () => {
      redisMock.incrementCounter.mockResolvedValue(
        CONTACT_LOOKUP_MAX_PER_WINDOW,
      );
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(
        service.lookupContactUserByEmail('u1', 'nobody@example.com'),
      ).resolves.toMatchObject({ found: false });
    });

    it('throws 429 with a human message once the budget is spent, without touching the database', async () => {
      redisMock.incrementCounter.mockResolvedValue(
        CONTACT_LOOKUP_MAX_PER_WINDOW + 1,
      );

      const error: unknown = await service
        .lookupContactUserByEmail('u1', 'ada@example.com')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ThrottlerException);
      expect((error as ThrottlerException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect((error as ThrottlerException).message).toBe(
        CONTACT_LOOKUP_RATE_LIMITED,
      );
      // No oracle for the attacker: the query never runs.
      expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    });

    it('fails open when Redis is unavailable (per-IP throttle still applies)', async () => {
      redisMock.incrementCounter.mockResolvedValue(null);
      prismaMock.user.findUnique.mockResolvedValue(friend);
      prismaMock.trustedContact.findUnique.mockResolvedValue(null);

      await expect(
        service.lookupContactUserByEmail('u1', 'ada@example.com'),
      ).resolves.toMatchObject({ found: true });
    });
  });

  // ── createContact ────────────────────────────────────────────────────────

  describe('createContact', () => {
    it('rejects with 400 and the exact message when no reachable field is given', async () => {
      const dto: CreateContactDto = { name: 'Mum' };
      await expect(service.createContact('u1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.createContact('u1', dto)).rejects.toThrow(
        CONTACT_NEEDS_REACHABLE_FIELD,
      );
      expect(prismaMock.trustedContact.create).not.toHaveBeenCalled();
    });

    it('rejects self-link with 400 and never creates a row', async () => {
      const dto: CreateContactDto = { name: 'Me', contactUserId: 'u1' };
      await expect(service.createContact('u1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.createContact('u1', dto)).rejects.toThrow(
        /can't add yourself as your own trusted contact/,
      );
      expect(prismaMock.trustedContact.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown contactUserId with 404 and a human message', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      const dto: CreateContactDto = { name: 'Ghost', contactUserId: 'nope' };
      await expect(service.createContact('u1', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.createContact('u1', dto)).rejects.toThrow(
        LINKED_USER_NOT_FOUND,
      );
      // The raw id is never quoted back at the user.
      await expect(service.createContact('u1', dto)).rejects.not.toThrow(
        /nope/,
      );
      expect(prismaMock.trustedContact.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate linked contact with 409', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'friend' });
      prismaMock.trustedContact.findUnique.mockResolvedValue({
        id: 'existing',
      });
      const dto: CreateContactDto = { name: 'Dup', contactUserId: 'friend' };

      await expect(service.createContact('u1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.createContact('u1', dto)).rejects.toThrow(
        DUPLICATE_LINKED_CONTACT,
      );
      expect(prismaMock.trustedContact.create).not.toHaveBeenCalled();
    });

    it('creates a linked contact on the happy path', async () => {
      const created = { id: 'c1', contactUser: { id: 'friend' } };
      prismaMock.user.findUnique.mockResolvedValue({ id: 'friend' });
      prismaMock.trustedContact.findUnique.mockResolvedValue(null);
      prismaMock.trustedContact.create.mockResolvedValue(created);

      const dto: CreateContactDto = {
        name: 'Bestie',
        contactUserId: 'friend',
        relation: 'friend',
      };
      const result = await service.createContact('u1', dto);

      expect(result).toBe(created);
      const arg = firstArg<Prisma.TrustedContactCreateArgs>(
        prismaMock.trustedContact.create,
      );
      expect(arg.data).toEqual({
        userId: 'u1',
        name: 'Bestie',
        phone: null,
        email: null,
        contactUserId: 'friend',
        relation: 'friend',
      });
      expect(arg.include).toBe(CONTACT_USER_SELECT);
    });

    it('creates an unlinked phone-only contact (no user lookup)', async () => {
      const created = { id: 'c2' };
      prismaMock.trustedContact.create.mockResolvedValue(created);

      const dto: CreateContactDto = {
        name: 'Neighbour',
        phone: '+15551234567',
      };
      const result = await service.createContact('u1', dto);

      expect(result).toBe(created);
      expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
      const arg = firstArg<Prisma.TrustedContactCreateArgs>(
        prismaMock.trustedContact.create,
      );
      expect(arg.data.phone).toBe('+15551234567');
      expect(arg.data.contactUserId).toBeNull();
    });

    it('maps a P2002 create race to ConflictException', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'friend' });
      prismaMock.trustedContact.findUnique.mockResolvedValue(null);
      prismaMock.trustedContact.create.mockRejectedValue(prismaError('P2002'));

      const dto: CreateContactDto = { name: 'Race', contactUserId: 'friend' };
      await expect(service.createContact('u1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('maps a P2003 create race (linked user deleted) to NotFoundException', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'friend' });
      prismaMock.trustedContact.findUnique.mockResolvedValue(null);
      prismaMock.trustedContact.create.mockRejectedValue(prismaError('P2003'));

      const dto: CreateContactDto = { name: 'Race', contactUserId: 'friend' };
      await expect(service.createContact('u1', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ── listContacts (BACKWARD-COMPATIBLE SHAPE — do not paginate) ────────────

  describe('listContacts', () => {
    it('returns a FLAT ARRAY of every contact, unpaginated', async () => {
      // TestFlight builds already in users' hands index straight into this
      // array. If this test ever needs changing, the app is already broken.
      const rows = [
        { id: 'c1', name: 'Mum', favorite: true },
        { id: 'c2', name: 'Ada', favorite: false },
      ];
      prismaMock.trustedContact.findMany.mockResolvedValue(rows);

      const result = await service.listContacts('u1');

      expect(Array.isArray(result)).toBe(true);
      expect(result).toBe(rows);
      const arg = firstArg<Prisma.TrustedContactFindManyArgs>(
        prismaMock.trustedContact.findMany,
      );
      expect(arg.skip).toBeUndefined();
      expect(arg.take).toBeUndefined();
      expect(arg.where).toEqual({ userId: 'u1' });
    });

    it('carries the additive `favorite` field on each item', async () => {
      prismaMock.trustedContact.findMany.mockResolvedValue([
        { id: 'c1', name: 'Mum', favorite: true },
      ]);
      const result = await service.listContacts('u1');
      expect(result[0]).toHaveProperty('favorite', true);
    });
  });

  // ── listContactsPage (paged + searchable) ────────────────────────────────

  describe('listContactsPage', () => {
    const page1 = [{ id: 'c1', name: 'Mum', favorite: true }];

    beforeEach(() => {
      prismaMock.trustedContact.findMany.mockResolvedValue(page1);
      prismaMock.trustedContact.count.mockResolvedValue(42);
    });

    it('returns the { data, page, limit, total } envelope', async () => {
      await expect(service.listContactsPage('u1', {})).resolves.toEqual({
        data: page1,
        page: 1,
        limit: CONTACT_PAGE_DEFAULT_LIMIT,
        total: 42,
      });
    });

    it('defaults to page 1 with a page size of 10', async () => {
      await service.listContactsPage('u1', {});
      const arg = firstArg<Prisma.TrustedContactFindManyArgs>(
        prismaMock.trustedContact.findMany,
      );
      expect(arg.skip).toBe(0);
      expect(arg.take).toBe(CONTACT_PAGE_DEFAULT_LIMIT);
    });

    it('skips (page - 1) * limit rows', async () => {
      await service.listContactsPage('u1', { page: 3, limit: 10 });
      const arg = firstArg<Prisma.TrustedContactFindManyArgs>(
        prismaMock.trustedContact.findMany,
      );
      expect(arg.skip).toBe(20);
      expect(arg.take).toBe(10);
    });

    it('caps limit at 50 and reports the CAPPED value back', async () => {
      // Reporting the cap matters: a client that asked for 500 and got 50 rows
      // must not conclude it has reached the end of the list.
      const result = await service.listContactsPage('u1', { limit: 500 });
      expect(result.limit).toBe(CONTACT_PAGE_MAX_LIMIT);
      const arg = firstArg<Prisma.TrustedContactFindManyArgs>(
        prismaMock.trustedContact.findMany,
      );
      expect(arg.take).toBe(CONTACT_PAGE_MAX_LIMIT);
    });

    it('orders favourites first, then name A-Z, then id', async () => {
      // Postgres does the sorting; what this asserts is the instruction we give
      // it. The trailing `id` is the stable tiebreak that stops `skip`/`take`
      // dropping or repeating a row when two contacts share a name.
      await service.listContactsPage('u1', {});
      const arg = firstArg<Prisma.TrustedContactFindManyArgs>(
        prismaMock.trustedContact.findMany,
      );
      expect(arg.orderBy).toEqual([
        { favorite: 'desc' },
        { name: 'asc' },
        { id: 'asc' },
      ]);
    });

    it('matches q against name, email AND phone, case-insensitively', async () => {
      await service.listContactsPage('u1', { q: 'MuM' });
      const arg = firstArg<Prisma.TrustedContactFindManyArgs>(
        prismaMock.trustedContact.findMany,
      );
      expect(arg.where).toEqual({
        userId: 'u1',
        OR: [
          { name: { contains: 'MuM', mode: 'insensitive' } },
          { email: { contains: 'MuM', mode: 'insensitive' } },
          { phone: { contains: 'MuM', mode: 'insensitive' } },
        ],
      });
    });

    it('finds a contact by a fragment of their phone number', async () => {
      await service.listContactsPage('u1', { q: '4567' });
      const arg = firstArg<Prisma.TrustedContactFindManyArgs>(
        prismaMock.trustedContact.findMany,
      );
      const or = arg.where?.OR as Prisma.TrustedContactWhereInput[];
      expect(or).toContainEqual({
        phone: { contains: '4567', mode: 'insensitive' },
      });
    });

    it('applies no search filter when q is absent or blank', async () => {
      await service.listContactsPage('u1', { q: '   ' });
      const arg = firstArg<Prisma.TrustedContactFindManyArgs>(
        prismaMock.trustedContact.findMany,
      );
      expect(arg.where).toEqual({ userId: 'u1' });
    });

    it('is scoped to the caller and counts the SAME filtered set', async () => {
      await service.listContactsPage('u1', { q: 'ada' });
      const findArg = firstArg<Prisma.TrustedContactFindManyArgs>(
        prismaMock.trustedContact.findMany,
      );
      const countArg = firstArg<Prisma.TrustedContactCountArgs>(
        prismaMock.trustedContact.count,
      );
      expect(findArg.where).toHaveProperty('userId', 'u1');
      // A mismatched count is how "12 of 40" starts lying to people.
      expect(countArg.where).toEqual(findArg.where);
      // One transaction, so a row added mid-request cannot split them.
      expect(prismaMock.$transaction).toHaveBeenCalled();
    });
  });

  // ── updateContact — favourite toggling ───────────────────────────────────

  describe('updateContact (favorite)', () => {
    const existing = {
      id: 'c1',
      userId: 'u1',
      name: 'Mum',
      phone: '+15551234567',
      email: null,
      contactUserId: null,
      relation: null,
      favorite: false,
    };

    it('sets favorite without touching any other field', async () => {
      prismaMock.trustedContact.findFirst.mockResolvedValue(existing);
      prismaMock.trustedContact.update.mockResolvedValue({
        ...existing,
        favorite: true,
      });

      const dto: UpdateContactDto = { favorite: true };
      const result = await service.updateContact('u1', 'c1', dto);

      expect(result).toHaveProperty('favorite', true);
      const arg = firstArg<Prisma.TrustedContactUpdateArgs>(
        prismaMock.trustedContact.update,
      );
      expect(arg.data).toEqual({ favorite: true });
    });

    it('un-favourites with an explicit false (not by omission)', async () => {
      prismaMock.trustedContact.findFirst.mockResolvedValue({
        ...existing,
        favorite: true,
      });
      prismaMock.trustedContact.update.mockResolvedValue(existing);

      await service.updateContact('u1', 'c1', { favorite: false });

      const arg = firstArg<Prisma.TrustedContactUpdateArgs>(
        prismaMock.trustedContact.update,
      );
      expect(arg.data).toEqual({ favorite: false });
    });

    it('leaves favorite alone when the field is omitted', async () => {
      prismaMock.trustedContact.findFirst.mockResolvedValue(existing);
      prismaMock.trustedContact.update.mockResolvedValue(existing);

      await service.updateContact('u1', 'c1', { name: 'Mummy' });

      const arg = firstArg<Prisma.TrustedContactUpdateArgs>(
        prismaMock.trustedContact.update,
      );
      expect(arg.data).toEqual({ name: 'Mummy' });
      expect(arg.data).not.toHaveProperty('favorite');
    });

    it("404s on another account's contact instead of favouriting it", async () => {
      // Scoped read: `{ id, userId }` matches nothing, so this is a 404 with
      // the ordinary message — never a 403 that would confirm the id exists.
      prismaMock.trustedContact.findFirst.mockResolvedValue(null);

      await expect(
        service.updateContact('u1', 'someone-elses', { favorite: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.updateContact('u1', 'someone-elses', { favorite: true }),
      ).rejects.toThrow(CONTACT_NOT_FOUND);
      expect(prismaMock.trustedContact.update).not.toHaveBeenCalled();
    });
  });

  // ── contact groups ───────────────────────────────────────────────────────

  const GROUP_CREATED_AT = new Date('2026-07-26T09:00:00Z');

  /** A ContactGroup row as prisma returns it with CONTACT_GROUP_MEMBERS_INCLUDE. */
  const groupRow = (
    overrides: Partial<{
      id: string;
      name: string;
      favorite: boolean;
      contactIds: string[];
    }> = {},
  ) => ({
    id: overrides.id ?? 'g1',
    userId: 'u1',
    name: overrides.name ?? 'Family',
    favorite: overrides.favorite ?? false,
    createdAt: GROUP_CREATED_AT,
    members: (overrides.contactIds ?? []).map((contactId) => ({ contactId })),
  });

  describe('listContactGroups', () => {
    it('maps rows to { id, name, favorite, memberCount, contactIds, createdAt }', async () => {
      prismaMock.contactGroup.findMany.mockResolvedValue([
        groupRow({ contactIds: ['c1', 'c2'] }),
      ]);

      await expect(service.listContactGroups('u1', {})).resolves.toEqual([
        {
          id: 'g1',
          name: 'Family',
          favorite: false,
          memberCount: 2,
          contactIds: ['c1', 'c2'],
          createdAt: GROUP_CREATED_AT,
        },
      ]);
      const arg = firstArg<Prisma.ContactGroupFindManyArgs>(
        prismaMock.contactGroup.findMany,
      );
      expect(arg.where).toEqual({ userId: 'u1' });
      expect(arg.include).toBe(CONTACT_GROUP_MEMBERS_INCLUDE);
    });

    it('filters on the group name, case-insensitively, still scoped to the caller', async () => {
      prismaMock.contactGroup.findMany.mockResolvedValue([]);

      await service.listContactGroups('u1', { q: 'FAM' });

      const arg = firstArg<Prisma.ContactGroupFindManyArgs>(
        prismaMock.contactGroup.findMany,
      );
      expect(arg.where).toEqual({
        userId: 'u1',
        name: { contains: 'FAM', mode: 'insensitive' },
      });
    });

    it('orders favourites first, then name, then id', async () => {
      prismaMock.contactGroup.findMany.mockResolvedValue([]);
      await service.listContactGroups('u1', {});
      const arg = firstArg<Prisma.ContactGroupFindManyArgs>(
        prismaMock.contactGroup.findMany,
      );
      expect(arg.orderBy).toEqual([
        { favorite: 'desc' },
        { name: 'asc' },
        { id: 'asc' },
      ]);
    });
  });

  describe('createContactGroup', () => {
    it('creates the group and its membership in one write', async () => {
      prismaMock.trustedContact.findMany.mockResolvedValue([
        { id: 'c1' },
        { id: 'c2' },
      ]);
      prismaMock.contactGroup.create.mockResolvedValue(
        groupRow({ contactIds: ['c1', 'c2'] }),
      );

      const dto: CreateContactGroupDto = {
        name: 'Family',
        contactIds: ['c1', 'c2'],
      };
      await expect(service.createContactGroup('u1', dto)).resolves.toEqual({
        id: 'g1',
        name: 'Family',
        favorite: false,
        memberCount: 2,
        contactIds: ['c1', 'c2'],
        createdAt: GROUP_CREATED_AT,
      });

      const arg = firstArg<Prisma.ContactGroupCreateArgs>(
        prismaMock.contactGroup.create,
      );
      expect(arg.data).toEqual({
        userId: 'u1',
        name: 'Family',
        favorite: false,
        members: { create: [{ contactId: 'c1' }, { contactId: 'c2' }] },
      });
    });

    it('trims the name and dedups repeated contact ids', async () => {
      prismaMock.trustedContact.findMany.mockResolvedValue([{ id: 'c1' }]);
      prismaMock.contactGroup.create.mockResolvedValue(
        groupRow({ contactIds: ['c1'] }),
      );

      await service.createContactGroup('u1', {
        name: '  Family  ',
        contactIds: ['c1', 'c1'],
      });

      const arg = firstArg<Prisma.ContactGroupCreateArgs>(
        prismaMock.contactGroup.create,
      );
      expect(arg.data.name).toBe('Family');
      expect(arg.data).toHaveProperty('members', {
        create: [{ contactId: 'c1' }],
      });
    });

    it('creates an empty group when no contactIds are given (no lookup)', async () => {
      prismaMock.contactGroup.create.mockResolvedValue(groupRow());

      const result = await service.createContactGroup('u1', { name: 'Work' });

      expect(result.memberCount).toBe(0);
      expect(result.contactIds).toEqual([]);
      expect(prismaMock.trustedContact.findMany).not.toHaveBeenCalled();
      const arg = firstArg<Prisma.ContactGroupCreateArgs>(
        prismaMock.contactGroup.create,
      );
      expect(arg.data).not.toHaveProperty('members');
    });

    it('honours favorite: true on create', async () => {
      prismaMock.contactGroup.create.mockResolvedValue(
        groupRow({ favorite: true }),
      );
      const result = await service.createContactGroup('u1', {
        name: 'Family',
        favorite: true,
      });
      expect(result.favorite).toBe(true);
      const arg = firstArg<Prisma.ContactGroupCreateArgs>(
        prismaMock.contactGroup.create,
      );
      expect(arg.data.favorite).toBe(true);
    });

    it('rejects contact ids that are not the caller’s, naming them, and creates nothing', async () => {
      // Same failure a stale list picker produces for trip watchers, and the
      // same message shape — a contact on another account looks exactly like a
      // deleted one, so this never confirms the id exists.
      prismaMock.trustedContact.findMany.mockResolvedValue([{ id: 'c1' }]);

      const dto: CreateContactGroupDto = {
        name: 'Family',
        contactIds: ['c1', 'someone-elses'],
      };
      await expect(
        service.createContactGroup('u1', dto),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.createContactGroup('u1', dto)).rejects.toThrow(
        contactIdsNotYours(['someone-elses']),
      );
      expect(prismaMock.contactGroup.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate name with 409, quoting the group that already exists', async () => {
      // Stored as "Family"; the caller typed "family". The message quotes the
      // stored casing so they can see what it clashed with.
      prismaMock.contactGroup.findFirst.mockResolvedValue({ name: 'Family' });

      const dto: CreateContactGroupDto = { name: 'family' };
      await expect(
        service.createContactGroup('u1', dto),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(service.createContactGroup('u1', dto)).rejects.toThrow(
        duplicateContactGroupName('Family'),
      );
      expect(prismaMock.contactGroup.create).not.toHaveBeenCalled();
      // Case-insensitive by design — two "Family" groups in a picker is a bug.
      const arg = firstArg<Prisma.ContactGroupFindFirstArgs>(
        prismaMock.contactGroup.findFirst,
      );
      expect(arg.where).toEqual({
        userId: 'u1',
        name: { equals: 'family', mode: 'insensitive' },
      });
    });

    it('maps a P2002 create race (concurrent same name) to 409', async () => {
      prismaMock.contactGroup.create.mockRejectedValue(prismaError('P2002'));
      await expect(
        service.createContactGroup('u1', { name: 'Family' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps a P2003 create race (contact deleted mid-flow) to a 400', async () => {
      prismaMock.trustedContact.findMany.mockResolvedValue([{ id: 'c1' }]);
      prismaMock.contactGroup.create.mockRejectedValue(prismaError('P2003'));
      await expect(
        service.createContactGroup('u1', {
          name: 'Family',
          contactIds: ['c1'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updateContactGroup', () => {
    it("404s on another account's group and writes nothing", async () => {
      // The ownership read is `{ id, userId }`, so someone else's real id and a
      // deleted id are indistinguishable from here — deliberately not a 403.
      prismaMock.contactGroup.findFirst.mockResolvedValue(null);

      const dto: UpdateContactGroupDto = { name: 'Mine now' };
      await expect(
        service.updateContactGroup('u1', 'someone-elses', dto),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.updateContactGroup('u1', 'someone-elses', dto),
      ).rejects.toThrow(CONTACT_GROUP_NOT_FOUND);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(prismaMock.contactGroup.update).not.toHaveBeenCalled();
      expect(prismaMock.contactGroupMember.deleteMany).not.toHaveBeenCalled();
    });

    it('REPLACES the whole membership when contactIds is present', async () => {
      prismaMock.contactGroup.findFirst.mockResolvedValueOnce({
        id: 'g1',
        name: 'Family',
      });
      prismaMock.trustedContact.findMany.mockResolvedValue([{ id: 'c9' }]);
      prismaMock.contactGroup.update.mockResolvedValue(
        groupRow({ contactIds: ['c9'] }),
      );

      const result = await service.updateContactGroup('u1', 'g1', {
        contactIds: ['c9'],
      });

      expect(prismaMock.contactGroupMember.deleteMany).toHaveBeenCalledWith({
        where: { groupId: 'g1' },
      });
      expect(prismaMock.contactGroupMember.createMany).toHaveBeenCalledWith({
        data: [{ groupId: 'g1', contactId: 'c9' }],
      });
      expect(result.contactIds).toEqual(['c9']);
    });

    it('empties the group when contactIds is [] (present, not absent)', async () => {
      prismaMock.contactGroup.findFirst.mockResolvedValueOnce({
        id: 'g1',
        name: 'Family',
      });
      prismaMock.contactGroup.update.mockResolvedValue(groupRow());

      const result = await service.updateContactGroup('u1', 'g1', {
        contactIds: [],
      });

      expect(prismaMock.contactGroupMember.deleteMany).toHaveBeenCalledWith({
        where: { groupId: 'g1' },
      });
      // Nothing to insert — and critically, no fallback to "leave it alone".
      expect(prismaMock.contactGroupMember.createMany).not.toHaveBeenCalled();
      expect(result.memberCount).toBe(0);
    });

    it('PRESERVES the membership when contactIds is absent', async () => {
      // A rename must never truncate a roster the app did not send.
      prismaMock.contactGroup.findFirst
        .mockResolvedValueOnce({ id: 'g1', name: 'Family' })
        .mockResolvedValueOnce(null);
      prismaMock.contactGroup.update.mockResolvedValue(
        groupRow({ name: 'Close family', contactIds: ['c1', 'c2'] }),
      );

      const result = await service.updateContactGroup('u1', 'g1', {
        name: 'Close family',
      });

      expect(prismaMock.contactGroupMember.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.contactGroupMember.createMany).not.toHaveBeenCalled();
      expect(result.contactIds).toEqual(['c1', 'c2']);
      const arg = firstArg<Prisma.ContactGroupUpdateArgs>(
        prismaMock.contactGroup.update,
      );
      expect(arg.data).toEqual({ name: 'Close family' });
    });

    it('rejects contact ids that are not the caller’s and writes nothing', async () => {
      prismaMock.contactGroup.findFirst.mockResolvedValueOnce({
        id: 'g1',
        name: 'Family',
      });
      prismaMock.trustedContact.findMany.mockResolvedValue([]);

      await expect(
        service.updateContactGroup('u1', 'g1', {
          contactIds: ['someone-elses'],
        }),
      ).rejects.toThrow(contactIdsNotYours(['someone-elses']));
      expect(prismaMock.contactGroupMember.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.contactGroup.update).not.toHaveBeenCalled();
    });

    it('rejects a rename onto an existing group name with 409', async () => {
      prismaMock.contactGroup.findFirst
        .mockResolvedValueOnce({ id: 'g1', name: 'Work' })
        .mockResolvedValueOnce({ name: 'Family' });

      await expect(
        service.updateContactGroup('u1', 'g1', { name: 'Family' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prismaMock.contactGroup.update).not.toHaveBeenCalled();
    });

    it('lets a group keep its own name (no self-clash)', async () => {
      prismaMock.contactGroup.findFirst.mockResolvedValueOnce({
        id: 'g1',
        name: 'Family',
      });
      prismaMock.contactGroup.update.mockResolvedValue(
        groupRow({ favorite: true }),
      );

      await expect(
        service.updateContactGroup('u1', 'g1', {
          name: 'Family',
          favorite: true,
        }),
      ).resolves.toHaveProperty('favorite', true);
      // Only the ownership read ran — the clash check is skipped when the name
      // is unchanged, so a favourite toggle can never 409 on itself.
      expect(prismaMock.contactGroup.findFirst).toHaveBeenCalledTimes(1);
    });

    it('maps a P2025 race (group deleted mid-update) to the 404 message', async () => {
      prismaMock.contactGroup.findFirst.mockResolvedValueOnce({
        id: 'g1',
        name: 'Family',
      });
      prismaMock.contactGroup.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.updateContactGroup('u1', 'g1', { favorite: true }),
      ).rejects.toThrow(CONTACT_GROUP_NOT_FOUND);
    });
  });

  describe('deleteContactGroup', () => {
    it('deletes the group and NEVER the contacts in it', async () => {
      prismaMock.contactGroup.deleteMany.mockResolvedValue({ count: 1 });

      await expect(
        service.deleteContactGroup('u1', 'g1'),
      ).resolves.toBeUndefined();

      expect(prismaMock.contactGroup.deleteMany).toHaveBeenCalledWith({
        where: { id: 'g1', userId: 'u1' },
      });
      // The cascade stops at contact_group_members. Losing a trusted contact to
      // a tidy-up would be a safety bug, not a tidy-up.
      expect(prismaMock.trustedContact.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.trustedContact.update).not.toHaveBeenCalled();
    });

    it("404s on another account's group, having deleted nothing", async () => {
      prismaMock.contactGroup.deleteMany.mockResolvedValue({ count: 0 });

      await expect(
        service.deleteContactGroup('u1', 'someone-elses'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.deleteContactGroup('u1', 'someone-elses'),
      ).rejects.toThrow(CONTACT_GROUP_NOT_FOUND);
      // Scoped in the same statement as the delete: the owner's row was never
      // at risk, and the caller learns nothing about whether the id exists.
      expect(prismaMock.contactGroup.deleteMany).toHaveBeenCalledWith({
        where: { id: 'someone-elses', userId: 'u1' },
      });
    });
  });

  // ── registerDevice ───────────────────────────────────────────────────────

  describe('registerDevice', () => {
    it('upserts keyed on token, reassigning userId so the device follows the new account', async () => {
      const device = {
        id: 'd1',
        token: 'tok-abc',
        platform: DevicePlatform.IOS,
        lastSeenAt: new Date('2026-07-22T00:00:00Z'),
        userId: 'newUser',
      };
      prismaMock.deviceToken.upsert.mockResolvedValue(device);

      const dto: RegisterDeviceDto = {
        token: 'tok-abc',
        platform: DevicePlatform.IOS,
      };
      const result = await service.registerDevice('newUser', dto);

      const arg = firstArg<Prisma.DeviceTokenUpsertArgs>(
        prismaMock.deviceToken.upsert,
      );
      expect(arg.where).toEqual({ token: 'tok-abc' });
      expect(arg.create).toEqual({
        userId: 'newUser',
        token: 'tok-abc',
        platform: DevicePlatform.IOS,
      });
      // The update branch reassigns userId (device follows the new account).
      expect(arg.update.userId).toBe('newUser');
      expect(arg.update.platform).toBe(DevicePlatform.IOS);
      expect(arg.update.lastSeenAt).toBeInstanceOf(Date);

      // Response is the safe projection — no userId leaked.
      expect(result).toEqual({
        id: 'd1',
        token: 'tok-abc',
        platform: DevicePlatform.IOS,
        lastSeenAt: device.lastSeenAt,
      });
      expect(result).not.toHaveProperty('userId');
    });
  });

  // ── applyBoundedReputationPenalty ────────────────────────────────────────
  //
  // Used today by SOS retraction. The clamp is the interesting part: a penalty
  // must never push someone below the caller's floor, and — the easy bug — must
  // never RAISE someone who is already below it.

  describe('applyBoundedReputationPenalty', () => {
    /** The interpolated values of the tagged-template query, in order. */
    const queryValues = (mock: jest.Mock): unknown[] => {
      const [, ...values] = mock.mock.calls[0] as unknown[];
      return values;
    };
    /** The SQL text, whitespace-collapsed, for asserting the clamp shape. */
    const querySql = (mock: jest.Mock): string => {
      const [strings] = mock.mock.calls[0] as [string[]];
      return strings.join('?').replace(/\s+/g, ' ').trim();
    };

    it('writes the penalty and the floor as bound parameters, never as string SQL', async () => {
      prismaMock.$queryRaw.mockResolvedValue([{ reputation: -3 }]);

      await service.applyBoundedReputationPenalty('u1', -3, -20);

      expect(queryValues(prismaMock.$queryRaw)).toEqual([-3, -20, 'u1']);
    });

    it('clamps in ONE statement, and against LEAST(reputation, floor)', async () => {
      await service.applyBoundedReputationPenalty('u1', -3, -20);

      const sql = querySql(prismaMock.$queryRaw);
      // One UPDATE — never a read-modify-write, which two concurrent penalties
      // would race and one would lose.
      expect(sql).toMatch(/^UPDATE "users"/);
      expect(sql).toMatch(/GREATEST\(\s*"reputation" \+ \?/);
      // The inner LEAST is what stops the floor from becoming a free top-up for
      // anyone already below it.
      expect(sql).toMatch(/LEAST\("reputation", \?/);
      expect(sql).toMatch(/RETURNING "reputation"/);
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('returns the reputation the database ended up with', async () => {
      prismaMock.$queryRaw.mockResolvedValue([{ reputation: -20 }]);
      await expect(
        service.applyBoundedReputationPenalty('u1', -3, -20),
      ).resolves.toBe(-20);
    });

    it('returns null (not an error) when the account no longer exists', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);
      await expect(
        service.applyBoundedReputationPenalty('gone', -3, -20),
      ).resolves.toBeNull();
    });

    it('refuses a positive delta — a reward must never ride the floor clamp', async () => {
      await expect(
        service.applyBoundedReputationPenalty('u1', 5, -20),
      ).rejects.toThrow(/must never be used to award reputation/);
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('surfaces a database failure to the caller rather than reporting a silent success', async () => {
      prismaMock.$queryRaw.mockRejectedValue(new Error('db down'));
      await expect(
        service.applyBoundedReputationPenalty('u1', -3, -20),
      ).rejects.toThrow('db down');
    });
  });

  // ── removeDevice ─────────────────────────────────────────────────────────

  describe('removeDevice', () => {
    it('scopes deletion to the caller and is idempotent (no throw when nothing matched)', async () => {
      prismaMock.deviceToken.deleteMany.mockResolvedValue({ count: 0 });

      await expect(
        service.removeDevice('u1', 'unknown-token'),
      ).resolves.toBeUndefined();
      expect(prismaMock.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { token: 'unknown-token', userId: 'u1' },
      });
    });

    it('removes a matching token', async () => {
      prismaMock.deviceToken.deleteMany.mockResolvedValue({ count: 1 });
      await expect(
        service.removeDevice('u1', 'tok-abc'),
      ).resolves.toBeUndefined();
      expect(prismaMock.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { token: 'tok-abc', userId: 'u1' },
      });
    });
  });
});
