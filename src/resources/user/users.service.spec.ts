import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DevicePlatform, Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../providers/redis/redis.service';
import type { CreateContactDto } from './dto/create-contact.dto';
import type { RegisterDeviceDto } from './dto/register-device.dto';
import {
  CONTACT_NEEDS_REACHABLE_FIELD,
  CONTACT_USER_SELECT,
  DUPLICATE_LINKED_CONTACT,
  googleEmailLinkedElsewhere,
  googleEmailNotVerified,
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
    };
    deviceToken: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let redisMock: { clearPresence: jest.Mock };

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
      },
      deviceToken: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
      // Runs the callback against the same mock so tx-based code paths work.
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prismaMock)),
    };
    redisMock = { clearPresence: jest.fn().mockResolvedValue(undefined) };

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
      logger: { error: jest.Mock; log: jest.Mock };
    };
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
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

    it('rejects an unknown contactUserId with 404', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      const dto: CreateContactDto = { name: 'Ghost', contactUserId: 'nope' };
      await expect(service.createContact('u1', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.createContact('u1', dto)).rejects.toThrow(
        /No RoamWarden user exists with id nope/,
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
