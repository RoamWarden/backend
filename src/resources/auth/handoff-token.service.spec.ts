import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { HANDOFF_TOKEN_TTL_S } from '../../common/constants';
import { keyHandoffToken } from '../../providers/redis/constant/redis.constants';
import { RedisService } from '../../providers/redis/redis.service';
import { UsersService } from '../user/users.service';
import { HandoffTokenService } from './handoff-token.service';
import { TokensService } from './tokens.service';

const HANDOFF_SECRET = 'test-refresh-secret';

/** Re-implements the service's keyed hash so tests can locate the stored key. */
function expectedKey(rawToken: string): string {
  return keyHandoffToken(
    createHmac('sha256', HANDOFF_SECRET)
      .update(`handoff:${rawToken}`)
      .digest('hex'),
  );
}

const SESSION = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  user: {
    id: 'user-1',
    email: 'traveller@example.com',
    name: 'Traveller',
    avatarUrl: null,
    reputation: 0,
  },
};

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'traveller@example.com',
    name: 'Traveller',
    avatarUrl: null,
    reputation: 0,
    ...overrides,
  } as User;
}

type StoredEntry = { value: string; expiresAt: number };

/**
 * Redis stand-in that honours the real semantics we depend on: TTL expiry and
 * an ATOMIC claim that hands the value to exactly one caller and burns it.
 */
function makeRedisMock() {
  const store = new Map<string, StoredEntry>();
  return {
    store,
    setWithTtl: jest.fn(
      (key: string, value: string, ttlS: number): Promise<void> => {
        store.set(key, { value, expiresAt: Date.now() + ttlS * 1000 });
        return Promise.resolve();
      },
    ),
    claimOnce: jest.fn((key: string): Promise<string | null> => {
      const entry = store.get(key);
      if (!entry) return Promise.resolve(null);
      // Read-and-burn in one step: a second caller finds nothing.
      store.delete(key);
      if (entry.expiresAt <= Date.now()) return Promise.resolve(null);
      return Promise.resolve(entry.value);
    }),
  };
}

describe('HandoffTokenService', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let tokensService: { issueSession: jest.Mock };
  let usersService: { findById: jest.Mock };
  let service: HandoffTokenService;

  beforeEach(() => {
    redis = makeRedisMock();
    tokensService = { issueSession: jest.fn().mockResolvedValue(SESSION) };
    usersService = { findById: jest.fn().mockResolvedValue(makeUser()) };
    const config = {
      getOrThrow: jest.fn().mockReturnValue(HANDOFF_SECRET),
    } as unknown as ConfigService;

    service = new HandoffTokenService(
      redis as unknown as RedisService,
      tokensService as unknown as TokensService,
      usersService as unknown as UsersService,
      config,
    );
  });

  describe('issue', () => {
    it('stores only a keyed HASH of the token (never the token) under a short TTL', async () => {
      const { token, expiresAt } = await service.issue('user-1');

      expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(redis.setWithTtl).toHaveBeenCalledTimes(1);
      const [key, value, ttlS] = (
        redis.setWithTtl.mock.calls as Array<[string, string, number]>
      )[0];
      expect(key).toBe(expectedKey(token));
      // The raw token must appear NOWHERE in what we persist.
      expect(key).not.toContain(token);
      expect(value).toBe('user-1');
      expect(ttlS).toBe(HANDOFF_TOKEN_TTL_S);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + HANDOFF_TOKEN_TTL_S * 1000,
      );
    });

    it('mints a different token every time', async () => {
      const first = await service.issue('user-1');
      const second = await service.issue('user-1');

      expect(first.token).not.toBe(second.token);
    });

    it('never hands back a token it failed to store (Redis down)', async () => {
      redis.setWithTtl.mockRejectedValue(new Error('redis unreachable'));
      jest
        .spyOn(
          (service as unknown as { logger: { error: jest.Mock } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);

      await expect(service.issue('user-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('exchange', () => {
    it('swaps a valid token for a normal session, exactly like login', async () => {
      const { token } = await service.issue('user-1');

      const session = await service.exchange(token);

      expect(redis.claimOnce).toHaveBeenCalledWith(expectedKey(token));
      expect(usersService.findById).toHaveBeenCalledWith('user-1');
      expect(tokensService.issueSession).toHaveBeenCalledWith(makeUser());
      expect(session).toEqual(SESSION);
    });

    it('is SINGLE-USE: the second redemption of the same token is rejected', async () => {
      const { token } = await service.issue('user-1');

      await expect(service.exchange(token)).resolves.toEqual(SESSION);
      await expect(service.exchange(token)).rejects.toThrow(
        UnauthorizedException,
      );
      // Only the first redemption ever minted a session.
      expect(tokensService.issueSession).toHaveBeenCalledTimes(1);
    });

    it('claims through ONE atomic read-and-burn, so concurrent redemptions cannot both win', async () => {
      const { token } = await service.issue('user-1');

      const results = await Promise.allSettled([
        service.exchange(token),
        service.exchange(token),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(tokensService.issueSession).toHaveBeenCalledTimes(1);
      // Atomicity lives in claimOnce (a single Lua GET+DEL) — the service must
      // not do a get-then-delete, which would let both callers through.
      expect(redis.claimOnce).toHaveBeenCalledTimes(2);
    });

    it('rejects an EXPIRED token', async () => {
      const { token } = await service.issue('user-1');
      // Age the stored entry past its TTL without waiting for real time.
      const entry = redis.store.get(expectedKey(token));
      if (!entry) throw new Error('the token was never stored');
      redis.store.set(expectedKey(token), {
        value: entry.value,
        expiresAt: Date.now() - 1,
      });

      await expect(service.exchange(token)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(tokensService.issueSession).not.toHaveBeenCalled();
    });

    it('gives an unknown token the SAME message as a reused one (no probing)', async () => {
      await expect(service.exchange('never-issued-token')).rejects.toThrow(
        /invalid, has expired/i,
      );

      const { token } = await service.issue('user-1');
      await service.exchange(token); // burn it
      await expect(service.exchange(token)).rejects.toThrow(
        /invalid, has expired/i,
      );
    });

    it('rejects when the account was deleted between minting and redeeming', async () => {
      const { token } = await service.issue('user-1');
      usersService.findById.mockResolvedValue(null);
      jest
        .spyOn(
          (service as unknown as { logger: { warn: jest.Mock } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      await expect(service.exchange(token)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(tokensService.issueSession).not.toHaveBeenCalled();
    });

    it('fails CLOSED (no session) when Redis cannot be reached', async () => {
      redis.claimOnce.mockRejectedValue(new Error('redis unreachable'));
      jest
        .spyOn(
          (service as unknown as { logger: { error: jest.Mock } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);

      await expect(service.exchange('some-token')).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(tokensService.issueSession).not.toHaveBeenCalled();
    });
  });
});
