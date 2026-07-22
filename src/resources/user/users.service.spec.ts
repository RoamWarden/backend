import {
  BadRequestException,
  ConflictException,
  NotFoundException,
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
} from './constant/users.constants';

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

describe('UsersService', () => {
  let service: UsersService;
  let prismaMock: {
    user: {
      findUnique: jest.Mock;
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
    it('upserts keyed on googleSub and returns the user', async () => {
      const user = { id: 'u1', email: 'a@b.com' };
      prismaMock.user.upsert.mockResolvedValue(user);

      const result = await service.upsertFromGoogle({
        sub: 'sub-123',
        email: 'a@b.com',
        name: 'Ada',
        avatarUrl: 'http://img/a.png',
      });

      expect(result).toBe(user);
      const arg = firstArg<Prisma.UserUpsertArgs>(prismaMock.user.upsert);
      expect(arg.where).toEqual({ googleSub: 'sub-123' });
      expect(arg.create).toEqual({
        googleSub: 'sub-123',
        email: 'a@b.com',
        name: 'Ada',
        avatarUrl: 'http://img/a.png',
      });
    });

    it('coerces a missing avatarUrl to null on create', async () => {
      prismaMock.user.upsert.mockResolvedValue({ id: 'u1' });
      await service.upsertFromGoogle({
        sub: 'sub-1',
        email: 'a@b.com',
        name: 'Ada',
      });
      const arg = firstArg<Prisma.UserUpsertArgs>(prismaMock.user.upsert);
      expect(arg.create.avatarUrl).toBeNull();
    });

    it('maps a P2002 (email owned by another identity) to ConflictException', async () => {
      prismaMock.user.upsert.mockRejectedValue(prismaError('P2002'));
      await expect(
        service.upsertFromGoogle({
          sub: 'sub-1',
          email: 'taken@b.com',
          name: 'Ada',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.upsertFromGoogle({
          sub: 'sub-1',
          email: 'taken@b.com',
          name: 'Ada',
        }),
      ).rejects.toThrow(
        /The email taken@b.com is already registered to a different RoamWarden account/,
      );
    });

    it('rethrows unexpected errors unchanged', async () => {
      const boom = new Error('db exploded');
      prismaMock.user.upsert.mockRejectedValue(boom);
      await expect(
        service.upsertFromGoogle({ sub: 's', email: 'e', name: 'n' }),
      ).rejects.toBe(boom);
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
