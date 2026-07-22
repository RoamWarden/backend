import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../../prisma/prisma.service';
import { TokensService } from './tokens.service';

// 40+ char secrets, as required by env validation in production.
const ACCESS_SECRET = 'a'.repeat(48);
const REFRESH_SECRET = 'r'.repeat(48);
const ALT_REFRESH_SECRET = 'x'.repeat(48);

const EXPIRED_ACCESS_MESSAGE =
  'Your session has expired — refresh your token or sign in again.';
const INVALID_ACCESS_MESSAGE =
  'Your session token is invalid — please sign in again.';
const INVALID_SESSION_MESSAGE =
  'This session is no longer valid — please sign in again.';
const EXPIRED_SESSION_MESSAGE =
  'Your session has expired — please sign in again.';
const GONE_ACCOUNT_MESSAGE =
  'This account no longer exists — please sign in again.';

type PrismaMock = {
  refreshToken: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
  };
  $transaction: jest.Mock;
};

/**
 * Builds a fresh Prisma mock. `$transaction(cb)` runs the callback against the
 * same mock so the service's tx-scoped updateMany/create/update are exercised.
 */
function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((cb: (tx: PrismaMock) => unknown) =>
    cb(mock),
  );
  return mock;
}

/** The relevant shape of a Prisma call argument used in these assertions. */
interface CallArg {
  data?: {
    userId?: string;
    tokenHash?: string;
    expiresAt?: Date;
    revokedAt?: Date | null;
    replacedByTokenId?: string;
  };
  where?: {
    id?: string;
    userId?: string;
    tokenHash?: string;
    revokedAt?: Date | null;
  };
}

/** `expect.any(Date)` as `unknown`, so it can be placed in typed literals without unsafe-any. */
const anyDate = (): unknown => expect.any(Date) as unknown;

/** Typed accessor for the first argument of the Nth recorded mock call. */
function callArg(mock: jest.Mock, callIndex = 0): CallArg {
  const calls = mock.mock.calls as CallArg[][];
  const args = calls[callIndex] ?? [];
  return args[0] ?? {};
}

function makeConfigMock(refreshSecret = REFRESH_SECRET): ConfigService {
  return {
    getOrThrow: jest.fn((key: string) => {
      switch (key) {
        case 'JWT_ACCESS_SECRET':
          return ACCESS_SECRET;
        case 'JWT_REFRESH_SECRET':
          return refreshSecret;
        default:
          throw new Error(`Unexpected getOrThrow(${key})`);
      }
    }),
    get: jest.fn((key: string) => {
      switch (key) {
        case 'JWT_ACCESS_TTL':
          return '15m';
        case 'JWT_REFRESH_TTL':
          return '30d';
        default:
          return undefined;
      }
    }),
  } as unknown as ConfigService;
}

async function buildService(
  prisma: PrismaMock,
  refreshSecret = REFRESH_SECRET,
): Promise<TokensService> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      TokensService,
      { provide: ConfigService, useValue: makeConfigMock(refreshSecret) },
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return moduleRef.get(TokensService);
}

describe('TokensService', () => {
  let prisma: PrismaMock;
  let service: TokensService;

  beforeEach(async () => {
    prisma = makePrismaMock();
    service = await buildService(prisma);
  });

  describe('access tokens', () => {
    it('round-trips { sub, email, type: "access" } through sign/verify', () => {
      const token = service.signAccessToken({
        id: 'user-1',
        email: 'traveler@example.com',
      });
      const payload = service.verifyAccessToken(token);
      expect(payload.sub).toBe('user-1');
      expect(payload.email).toBe('traveler@example.com');
      expect(payload.type).toBe('access');
      expect(typeof payload.iat).toBe('number');
      expect(typeof payload.exp).toBe('number');
    });

    it('throws the expired message on an expired token', () => {
      // Sign directly with the access secret and a past expiry.
      const expired = jwt.sign(
        { sub: 'user-1', email: 'traveler@example.com', type: 'access' },
        ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: -10 },
      );
      expect(() => service.verifyAccessToken(expired)).toThrow(
        UnauthorizedException,
      );
      expect(() => service.verifyAccessToken(expired)).toThrow(
        EXPIRED_ACCESS_MESSAGE,
      );
    });

    it('throws the invalid message on a garbage token', () => {
      expect(() => service.verifyAccessToken('not-a-jwt')).toThrow(
        INVALID_ACCESS_MESSAGE,
      );
    });

    it('throws the invalid message on a token signed with the wrong secret', () => {
      const foreign = jwt.sign(
        { sub: 'user-1', email: 'traveler@example.com', type: 'access' },
        'the'.repeat(20),
        { algorithm: 'HS256', expiresIn: 900 },
      );
      expect(() => service.verifyAccessToken(foreign)).toThrow(
        INVALID_ACCESS_MESSAGE,
      );
    });

    it('throws the invalid message when type !== "access"', () => {
      const wrongType = jwt.sign(
        { sub: 'user-1', email: 'traveler@example.com', type: 'refresh' },
        ACCESS_SECRET,
        { algorithm: 'HS256', expiresIn: 900 },
      );
      expect(() => service.verifyAccessToken(wrongType)).toThrow(
        INVALID_ACCESS_MESSAGE,
      );
    });
  });

  describe('issueRefreshToken', () => {
    it('stores an HMAC hash (64-char hex), never the raw token', async () => {
      prisma.refreshToken.create.mockResolvedValue({});
      const { token, expiresAt } = await service.issueRefreshToken('user-1');

      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
      const arg = callArg(prisma.refreshToken.create);
      const storedHash = arg.data?.tokenHash;

      expect(storedHash).not.toBe(token);
      expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(arg.data?.userId).toBe('user-1');
      expect(arg.data?.expiresAt).toBeInstanceOf(Date);
      expect(expiresAt).toBeInstanceOf(Date);
      // Far in the future (30d TTL).
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('is HMAC-keyed: a different JWT_REFRESH_SECRET yields a different hash for the same raw token', async () => {
      // Two services with different refresh secrets; hash the SAME raw token by
      // driving it through rotateRefreshToken's findUnique lookup, which uses
      // the internal hash(). We compare the where.tokenHash each produces.
      const prismaA = makePrismaMock();
      const prismaB = makePrismaMock();
      prismaA.refreshToken.findUnique.mockResolvedValue(null);
      prismaB.refreshToken.findUnique.mockResolvedValue(null);

      const serviceA = await buildService(prismaA, REFRESH_SECRET);
      const serviceB = await buildService(prismaB, ALT_REFRESH_SECRET);

      const raw = 'the-same-opaque-refresh-token';
      await expect(serviceA.rotateRefreshToken(raw)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(serviceB.rotateRefreshToken(raw)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      const hashA = callArg(prismaA.refreshToken.findUnique).where?.tokenHash;
      const hashB = callArg(prismaB.refreshToken.findUnique).where?.tokenHash;

      expect(hashA).toMatch(/^[0-9a-f]{64}$/);
      expect(hashB).toMatch(/^[0-9a-f]{64}$/);
      expect(hashA).not.toBe(hashB);
    });
  });

  describe('rotateRefreshToken', () => {
    const now = Date.now();
    const future = new Date(now + 60_000);

    it('throws 401 when the token hash is unknown', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);
      await expect(service.rotateRefreshToken('nope')).rejects.toThrow(
        INVALID_SESSION_MESSAGE,
      );
      await expect(service.rotateRefreshToken('nope')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('detects reuse of an already-revoked record: revokes ALL active tokens and throws 401', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: new Date(now - 1000),
        expiresAt: future,
      });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 3 });

      await expect(service.rotateRefreshToken('reused')).rejects.toThrow(
        INVALID_SESSION_MESSAGE,
      );

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: anyDate() },
      });
      // Reuse detection short-circuits before any rotation transaction.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws 401 when the record is expired', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(now - 1000),
      });
      await expect(service.rotateRefreshToken('expired')).rejects.toThrow(
        EXPIRED_SESSION_MESSAGE,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws 401 when the owning user has been deleted', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: future,
      });
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.rotateRefreshToken('orphan')).rejects.toThrow(
        GONE_ACCOUNT_MESSAGE,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('happy path: claims via updateMany({ id, revokedAt: null }), creates a new token, returns a fresh access+refresh pair', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: future,
      });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'traveler@example.com',
      });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt-2' });
      prisma.refreshToken.update.mockResolvedValue({});

      const result = await service.rotateRefreshToken('valid-token');

      // Ran inside a transaction.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      // Conditional atomic claim on the presented record.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'rt-1', revokedAt: null },
        data: { revokedAt: anyDate() },
      });

      // New token persisted as an HMAC hash, not raw.
      const createArg = callArg(prisma.refreshToken.create);
      expect(createArg.data?.userId).toBe('user-1');
      expect(createArg.data?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(createArg.data?.tokenHash).not.toBe(result.refreshToken);

      // Chains the old record to the new one.
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'rt-1' },
        data: { replacedByTokenId: 'rt-2' },
      });

      // Returns a usable access token + a new refresh token + the user.
      expect(result.user).toEqual({
        id: 'user-1',
        email: 'traveler@example.com',
      });
      expect(typeof result.refreshToken).toBe('string');
      const access = service.verifyAccessToken(result.accessToken);
      expect(access.sub).toBe('user-1');
      expect(access.email).toBe('traveler@example.com');
      expect(access.type).toBe('access');
    });

    it('TOCTOU: when the tx claim loses the race (count 0), revokes ALL active tokens and throws 401', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: future,
      });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'traveler@example.com',
      });
      // First updateMany call (inside tx, the claim) loses the race → count 0.
      // Second updateMany call (post-tx reuse revocation) → revokes actives.
      prisma.refreshToken.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 2 });

      await expect(service.rotateRefreshToken('raced-token')).rejects.toThrow(
        INVALID_SESSION_MESSAGE,
      );

      // The tx ran and the claim returned null → no new token was created.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();

      // Blanket revocation of every active session for the user.
      expect(prisma.refreshToken.updateMany).toHaveBeenLastCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: anyDate() },
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('revokeRefreshToken', () => {
    it('revokes the presented token by its hash, scoped to non-revoked rows', async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      await service.revokeRefreshToken('bye');

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
      const arg = callArg(prisma.refreshToken.updateMany);
      expect(arg.where?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(arg.where?.revokedAt).toBeNull();
      expect(arg.data).toEqual({ revokedAt: anyDate() });
    });

    it('is idempotent: count 0 does not throw', async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.revokeRefreshToken('already-gone'),
      ).resolves.toBeUndefined();
    });
  });
});
