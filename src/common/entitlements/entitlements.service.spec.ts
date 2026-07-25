import { ForbiddenException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  FREE_PLAN_CODE,
  PREMIUM_PLAN_CODE,
} from '../../resources/billing/constant/billing.constants';
import {
  ENTITLEMENTS_CACHE_TTL_MS,
  PLAN_CAPABILITY_ERROR_CODE,
  PLAN_LIMIT_ERROR_CODE,
  SHADOW_LOG_PREFIX,
} from './entitlement.constants';
import {
  EntitlementsService,
  parseEnforcementFlag,
} from './entitlements.service';

/** The free-tier numbers this test pins deliberately: they are a product promise. */
const FREE_LIMITS = {
  trustedContacts: 5,
  tripHistoryDays: 30,
  familyMembers: 0,
};

const NO_CAPABILITIES = {
  analytics: false,
  prioritySos: false,
  familyPlan: false,
  offlineMaps: false,
};

const ALL_CAPABILITIES = {
  analytics: true,
  prioritySos: true,
  familyPlan: true,
  offlineMaps: true,
};

type PrismaMock = { subscription: { findUnique: jest.Mock } };

describe('EntitlementsService', () => {
  let prisma: PrismaMock;
  let service: EntitlementsService;
  let debugSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  /** Builds the service with enforcement off (the shipping default) unless told otherwise. */
  function build(enforce?: string): EntitlementsService {
    const config = {
      get: jest.fn((key: string) =>
        key === 'ENFORCE_PLAN_LIMITS' ? enforce : undefined,
      ),
    } as unknown as ConfigService;
    return new EntitlementsService(prisma as unknown as PrismaService, config);
  }

  /** Makes the next lookup resolve to the given plan/status (null = no row). */
  function onPlan(planCode: string | null, status?: SubscriptionStatus): void {
    prisma.subscription.findUnique.mockResolvedValue(
      planCode === null
        ? null
        : {
            status: status ?? SubscriptionStatus.FREE,
            plan: { code: planCode },
          },
    );
  }

  beforeEach(() => {
    prisma = {
      subscription: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    // Keep test output readable and let us assert on the shadow-mode signal.
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    service = build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('resolution', () => {
    it('resolves a user with NO subscription row to the FREE limits', async () => {
      onPlan(null);

      const result = await service.getEntitlements('user-1');

      expect(result.planCode).toBe(FREE_PLAN_CODE);
      expect(result.entitledPlanCode).toBe(FREE_PLAN_CODE);
      expect(result.status).toBe(SubscriptionStatus.FREE);
      expect(result.isPremium).toBe(false);
      expect(result.limits).toEqual(FREE_LIMITS);
      expect(result.capabilities).toEqual(NO_CAPABILITIES);
      expect(result.enforced).toBe(false);
    });

    it('gives an ACTIVE premium subscriber unlimited limits and every capability', async () => {
      onPlan(PREMIUM_PLAN_CODE, SubscriptionStatus.ACTIVE);

      const result = await service.getEntitlements('user-1');

      expect(result.isPremium).toBe(true);
      expect(result.entitledPlanCode).toBe(PREMIUM_PLAN_CODE);
      // null is "unlimited" — never Infinity or -1, so it survives JSON intact.
      expect(result.limits.trustedContacts).toBeNull();
      expect(result.limits.tripHistoryDays).toBeNull();
      expect(result.capabilities).toEqual(ALL_CAPABILITIES);
    });

    it('grants NOTHING for a premium plan that is only PENDING (nobody paid)', async () => {
      onPlan(PREMIUM_PLAN_CODE, SubscriptionStatus.PENDING);

      const result = await service.getEntitlements('user-1');

      expect(result.planCode).toBe(PREMIUM_PLAN_CODE);
      expect(result.entitledPlanCode).toBe(FREE_PLAN_CODE);
      expect(result.isPremium).toBe(false);
      expect(result.limits).toEqual(FREE_LIMITS);
      expect(result.capabilities).toEqual(NO_CAPABILITIES);
    });

    it.each([
      SubscriptionStatus.FREE,
      SubscriptionStatus.CANCELLED,
      SubscriptionStatus.EXPIRED,
    ])(
      'resolves a premium plan in status %s to the FREE limits',
      async (status) => {
        onPlan(PREMIUM_PLAN_CODE, status);

        const result = await service.getEntitlements('user-1');

        expect(result.isPremium).toBe(false);
        expect(result.limits).toEqual(FREE_LIMITS);
      },
    );

    it('never downgrades an ENTITLED user whose plan is missing from the limits table', () => {
      const result = service.entitlementsFor({
        planCode: 'team-2027',
        status: SubscriptionStatus.ACTIVE,
      });

      // Falls back UP to premium (and shouts in the logs) rather than silently
      // stripping someone who is paying.
      expect(result.limits.trustedContacts).toBeNull();
      expect(result.capabilities).toEqual(ALL_CAPABILITIES);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('team-2027'),
      );
    });

    it('falls back to FREE for an unknown plan code that grants nothing', () => {
      const result = service.entitlementsFor({
        planCode: 'team-2027',
        status: SubscriptionStatus.PENDING,
      });

      expect(result.limits).toEqual(FREE_LIMITS);
    });

    it('resolves from a row the caller already has, without touching the database', () => {
      const result = service.entitlementsFor(null);

      expect(prisma.subscription.findUnique).not.toHaveBeenCalled();
      expect(result.limits).toEqual(FREE_LIMITS);
    });
  });

  describe('the enforcement switch is OFF (the shipping default)', () => {
    it('defaults to off when ENFORCE_PLAN_LIMITS is unset', () => {
      expect(service.isEnforced()).toBe(false);
    });

    it.each(['false', '', 'yes', '1', 'TRUE-ish', undefined])(
      'stays off for ENFORCE_PLAN_LIMITS=%p',
      (value) => {
        expect(build(value).isEnforced()).toBe(false);
      },
    );

    it('NEVER throws when a user is over a limit — and reports what it would have blocked', async () => {
      onPlan(null);

      const check = await service.assertWithinLimit(
        'user-1',
        'trustedContacts',
        12,
      );

      expect(check.allowed).toBe(true);
      expect(check.wouldBlock).toBe(true);
      expect(check.enforced).toBe(false);
      expect(check.limit).toBe(5);
      expect(check.current).toBe(12);
      expect(check.remaining).toBe(0);
      expect(check.message).toMatch(/limit of 5 trusted contacts/i);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining(SHADOW_LOG_PREFIX),
      );
    });

    it('allows a capability the plan does not include, and reports the would-block', async () => {
      onPlan(null);

      const check = await service.assertCapability('user-1', 'offlineMaps');

      expect(check.allowed).toBe(true);
      expect(check.granted).toBe(false);
      expect(check.wouldBlock).toBe(true);
      expect(check.message).toMatch(/offline maps is part of premium/i);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining(SHADOW_LOG_PREFIX),
      );
    });

    it('applies NO history cutoff, while still reporting the window it would apply', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
      onPlan(null);

      const window = await service.getWindow('user-1', 'tripHistoryDays');

      expect(window.since).toBeNull(); // the caller queries everything, as today
      expect(window.windowDays).toBe(30);
      expect(window.wouldApplySince).toEqual(
        new Date('2026-06-25T12:00:00.000Z'),
      );
      expect(window.enforced).toBe(false);
    });

    it('reports no would-block at all while the user is under the limit', async () => {
      onPlan(null);

      const check = await service.checkLimit('user-1', 'trustedContacts', 2);

      expect(check.wouldBlock).toBe(false);
      expect(check.remaining).toBe(3);
      expect(check.message).toBeNull();
      expect(debugSpy).not.toHaveBeenCalled();
    });
  });

  describe('the enforcement switch is ON', () => {
    beforeEach(() => {
      service = build('true');
    });

    it('turns on only for the exact string "true" (any case, trimmed)', () => {
      expect(service.isEnforced()).toBe(true);
      expect(build('  TRUE  ').isEnforced()).toBe(true);
    });

    it('blocks with a 403 carrying a human message and the numbers', async () => {
      onPlan(null);

      const error = await service
        .assertWithinLimit('user-1', 'trustedContacts', 5)
        .then(
          () => null,
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(ForbiddenException);
      const body = (error as ForbiddenException).getResponse() as Record<
        string,
        unknown
      >;
      expect(body.code).toBe(PLAN_LIMIT_ERROR_CODE);
      expect(body.message).toMatch(/limit of 5 trusted contacts/i);
      expect(body.limitKey).toBe('trustedContacts');
      expect(body.limit).toBe(5);
      expect(body.current).toBe(5);
      expect(body.planCode).toBe(FREE_PLAN_CODE);
      expect(body.upgradeTo).toBe(PREMIUM_PLAN_CODE);
    });

    it('allows the last item that fits (currentCount is the count BEFORE adding)', async () => {
      onPlan(null);

      const check = await service.assertWithinLimit(
        'user-1',
        'trustedContacts',
        4,
      );

      expect(check.allowed).toBe(true);
      expect(check.wouldBlock).toBe(false);
      expect(check.remaining).toBe(1);
    });

    it('never blocks an ACTIVE premium subscriber, however many they have', async () => {
      onPlan(PREMIUM_PLAN_CODE, SubscriptionStatus.ACTIVE);

      const check = await service.assertWithinLimit(
        'user-1',
        'trustedContacts',
        999,
      );

      expect(check.allowed).toBe(true);
      expect(check.wouldBlock).toBe(false);
      expect(check.limit).toBeNull();
      expect(check.remaining).toBeNull();
    });

    it('blocks a Premium-only capability on Free and allows it on ACTIVE premium', async () => {
      onPlan(null);
      await expect(
        service.assertCapability('user-1', 'analytics'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const error = await service.assertCapability('user-1', 'analytics').then(
        () => null,
        (caught: unknown) => caught,
      );
      const body = (error as ForbiddenException).getResponse() as Record<
        string,
        unknown
      >;
      expect(body.code).toBe(PLAN_CAPABILITY_ERROR_CODE);
      expect(body.capability).toBe('analytics');

      service.invalidate('user-1');
      onPlan(PREMIUM_PLAN_CODE, SubscriptionStatus.ACTIVE);
      await expect(
        service.assertCapability('user-1', 'analytics'),
      ).resolves.toEqual(expect.objectContaining({ allowed: true }));
    });

    it('blocks a limit of zero with copy that reads as a Premium feature', async () => {
      onPlan(null);

      const check = await service.checkLimit('user-1', 'familyMembers', 0);

      expect(check.wouldBlock).toBe(true);
      expect(check.message).toMatch(/family members are part of premium/i);
    });

    it('applies the history cutoff for Free and none for premium', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
      onPlan(null);

      const free = await service.getWindow('user-1', 'tripHistoryDays');
      expect(free.since).toEqual(new Date('2026-06-25T12:00:00.000Z'));

      onPlan(PREMIUM_PLAN_CODE, SubscriptionStatus.ACTIVE);
      const premium = await service.getWindow('user-2', 'tripHistoryDays');
      expect(premium.since).toBeNull();
      expect(premium.windowDays).toBeNull();
    });
  });

  describe('resilience', () => {
    it('fails OPEN when the subscription lookup breaks — a gate must never break a feature', async () => {
      service = build('true'); // even with enforcement ON
      prisma.subscription.findUnique.mockRejectedValue(new Error('db down'));

      const check = await service.assertWithinLimit(
        'user-1',
        'trustedContacts',
        99,
      );

      expect(check.allowed).toBe(true);
      expect(check.enforced).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('fail-open'),
      );
    });

    it('propagates the failure from getEntitlements (the endpoint must not lie)', async () => {
      prisma.subscription.findUnique.mockRejectedValue(new Error('db down'));

      await expect(service.getEntitlements('user-1')).rejects.toThrow(
        'db down',
      );
      // A rejected lookup is never memoized.
      await expect(service.getEntitlements('user-1')).rejects.toThrow(
        'db down',
      );
      expect(prisma.subscription.findUnique).toHaveBeenCalledTimes(2);
    });

    it('treats a nonsense count as zero rather than doing NaN maths', async () => {
      onPlan(null);

      const check = await service.checkLimit(
        'user-1',
        'trustedContacts',
        Number.NaN,
      );

      expect(check.current).toBe(0);
      expect(check.remaining).toBe(5);
      expect(check.wouldBlock).toBe(false);
    });
  });

  describe('caching', () => {
    it('collapses the checks of one request into a single query', async () => {
      onPlan(null);

      await Promise.all([
        service.getEntitlements('user-1'),
        service.checkLimit('user-1', 'trustedContacts', 1),
        service.checkCapability('user-1', 'prioritySos'),
      ]);

      expect(prisma.subscription.findUnique).toHaveBeenCalledTimes(1);
    });

    it('keeps users separate', async () => {
      onPlan(null);
      await service.getEntitlements('user-1');
      onPlan(PREMIUM_PLAN_CODE, SubscriptionStatus.ACTIVE);

      await expect(service.getEntitlements('user-2')).resolves.toEqual(
        expect.objectContaining({ isPremium: true }),
      );
      expect(prisma.subscription.findUnique).toHaveBeenCalledTimes(2);
    });

    it('re-reads after invalidate (a plan change must be visible immediately)', async () => {
      onPlan(null);
      await service.getEntitlements('user-1');

      service.invalidate('user-1');
      onPlan(PREMIUM_PLAN_CODE, SubscriptionStatus.ACTIVE);
      const after = await service.getEntitlements('user-1');

      expect(after.isPremium).toBe(true);
      expect(prisma.subscription.findUnique).toHaveBeenCalledTimes(2);
    });

    it('re-reads once the short TTL is up', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-25T12:00:00.000Z'));
      onPlan(null);
      await service.getEntitlements('user-1');

      jest.advanceTimersByTime(ENTITLEMENTS_CACHE_TTL_MS + 1);
      await service.getEntitlements('user-1');

      expect(prisma.subscription.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('parseEnforcementFlag', () => {
    it('only "true" means on — every ambiguous value means off', () => {
      expect(parseEnforcementFlag('true')).toBe(true);
      expect(parseEnforcementFlag(' True ')).toBe(true);
      expect(parseEnforcementFlag(true)).toBe(true);
      for (const value of ['false', '1', 'yes', 'on', '', undefined, null, 0]) {
        expect(parseEnforcementFlag(value)).toBe(false);
      }
    });
  });
});
