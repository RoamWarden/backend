import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import type { Plan, Subscription } from '@prisma/client';
import { EntitlementsService } from '../../common/entitlements';
import { PrismaService } from '../../prisma/prisma.service';
import { HandoffTokenService } from '../auth/handoff-token.service';
import { BillingService } from './billing.service';
import {
  FREE_PLAN_CODE,
  PREMIUM_PLAN_CODE,
} from './constant/billing.constants';
import { isPremiumEntitled } from './entitlements';

/** A P2002 unique-constraint violation as Prisma raises it. */
function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-free',
    code: FREE_PLAN_CODE,
    name: 'Free',
    description: 'Core safety for every traveller — always free.',
    priceAmountMinor: 0,
    currency: 'USD',
    interval: 'month',
    features: ['Core safety alerts', 'Basic trip sharing', 'SOS'],
    isActive: true,
    sortOrder: 0,
    createdAt: new Date('2026-07-25T00:00:00.000Z'),
    updatedAt: new Date('2026-07-25T00:00:00.000Z'),
    ...overrides,
  };
}

const PREMIUM_PLAN = makePlan({
  id: 'plan-premium',
  code: PREMIUM_PLAN_CODE,
  name: 'Premium',
  description: 'For travellers who want the full safety net.',
  priceAmountMinor: 500,
  features: ['Unlimited trusted contacts', 'Offline maps'],
  sortOrder: 1,
});

function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-1',
    userId: 'user-1',
    planId: 'plan-free',
    status: SubscriptionStatus.FREE,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    createdAt: new Date('2026-07-25T00:00:00.000Z'),
    updatedAt: new Date('2026-07-25T00:00:00.000Z'),
    ...overrides,
  };
}

type PrismaMock = {
  plan: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
  };
  subscription: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
  };
};

describe('BillingService', () => {
  let prisma: PrismaMock;
  let handoffTokens: { issue: jest.Mock };
  let entitlements: EntitlementsService;
  let service: BillingService;
  const env: Record<string, string> = {
    WEB_APP_URL: 'https://roamwarden.example/',
    API_BASE_URL: 'https://api.roamwarden.example',
  };

  function build(overrides: Record<string, string | undefined> = {}): void {
    const values: Record<string, string | undefined> = { ...env, ...overrides };
    const config = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    // The real EntitlementsService, not a stub: the entitlements embedded in
    // every billing response must be the ones the rest of the backend enforces.
    entitlements = new EntitlementsService(
      prisma as unknown as PrismaService,
      config,
    );
    service = new BillingService(
      prisma as unknown as PrismaService,
      handoffTokens as unknown as HandoffTokenService,
      entitlements,
      config,
    );
  }

  beforeEach(() => {
    prisma = {
      plan: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      subscription: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
    };
    handoffTokens = {
      issue: jest.fn().mockResolvedValue({
        token: 'handoff-token-value',
        expiresAt: new Date('2026-07-25T00:05:00.000Z'),
      }),
    };
    // Boot-time INFO lines (one per service built) would drown the output.
    // Warnings and errors still print — they are the ones worth seeing.
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getPlans', () => {
    it('returns only active plans in sortOrder, formatted, without leaking row ids', async () => {
      prisma.plan.findMany.mockResolvedValue([makePlan(), PREMIUM_PLAN]);

      const result = await service.getPlans();

      expect(prisma.plan.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      });
      expect(result.plans.map((plan) => plan.code)).toEqual([
        FREE_PLAN_CODE,
        PREMIUM_PLAN_CODE,
      ]);
      expect(result.plans[0]).toEqual({
        code: FREE_PLAN_CODE,
        name: 'Free',
        description: 'Core safety for every traveller — always free.',
        priceAmountMinor: 0,
        currency: 'USD',
        interval: 'month',
        priceFormatted: 'Free',
        features: ['Core safety alerts', 'Basic trip sharing', 'SOS'],
        sortOrder: 0,
        // What the plan INCLUDES, so a pricing page never restates numbers.
        limits: { trustedContacts: 5, tripHistoryDays: 30, familyMembers: 0 },
        capabilities: {
          analytics: false,
          prioritySos: false,
          familyPlan: false,
          offlineMaps: false,
        },
      });
      expect(result.plans[1].priceFormatted).toBe('$5.00');
      expect(result.plans[1].limits.trustedContacts).toBeNull(); // unlimited
      expect(result.plans[1].capabilities.offlineMaps).toBe(true);
      // The catalog row id is an internal detail; clients key off `code`.
      expect(result.plans[0]).not.toHaveProperty('id');
    });

    it('surfaces a clear error (never an empty pricing page) when the catalog is unseeded', async () => {
      prisma.plan.findMany.mockResolvedValue([]);

      await expect(service.getPlans()).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(service.getPlans()).rejects.toThrow(/aren't set up/i);
    });

    it('falls back to a plain amount for an unusable currency code', async () => {
      prisma.plan.findMany.mockResolvedValue([
        makePlan({ priceAmountMinor: 500, currency: 'not-a-currency' }),
      ]);

      const result = await service.getPlans();

      expect(result.plans[0].priceFormatted).toBe('5.00 not-a-currency');
    });
  });

  describe('getSubscription', () => {
    it('resolves a user with NO subscription row to the free plan with status FREE (never 404)', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);
      prisma.plan.findUnique.mockResolvedValue(makePlan());

      const result = await service.getSubscription('user-1');

      expect(prisma.plan.findUnique).toHaveBeenCalledWith({
        where: { code: FREE_PLAN_CODE },
      });
      expect(result.plan.code).toBe(FREE_PLAN_CODE);
      expect(result.status).toBe(SubscriptionStatus.FREE);
      expect(result.currentPeriodEnd).toBeNull();
      expect(result.cancelAtPeriodEnd).toBe(false);
      expect(result.isPremium).toBe(false);
      expect(result.paymentAvailable).toBe(false);
      // Entitlements ride along so the app can SHOW the plan without guessing —
      // and `enforced: false` says plainly that nothing is capped today.
      expect(result.entitlements).toEqual({
        planCode: FREE_PLAN_CODE,
        entitledPlanCode: FREE_PLAN_CODE,
        status: SubscriptionStatus.FREE,
        isPremium: false,
        limits: { trustedContacts: 5, tripHistoryDays: 30, familyMembers: 0 },
        capabilities: {
          analytics: false,
          prioritySos: false,
          familyPlan: false,
          offlineMaps: false,
        },
        enforced: false,
      });
    });

    it('reports a PENDING paid plan as NOT premium and payment as unavailable', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        ...makeSubscription({
          planId: PREMIUM_PLAN.id,
          status: SubscriptionStatus.PENDING,
        }),
        plan: PREMIUM_PLAN,
      });

      const result = await service.getSubscription('user-1');

      expect(result.status).toBe(SubscriptionStatus.PENDING);
      expect(result.isPremium).toBe(false);
      expect(result.paymentAvailable).toBe(false);
      expect(result.currentPeriodEnd).toBeNull();
      // Selected premium, entitled to free — PENDING grants nothing.
      expect(result.entitlements.planCode).toBe(PREMIUM_PLAN_CODE);
      expect(result.entitlements.entitledPlanCode).toBe(FREE_PLAN_CODE);
      expect(result.entitlements.limits.trustedContacts).toBe(5);
      expect(result.entitlements.capabilities.offlineMaps).toBe(false);
    });

    it('reports an ACTIVE paid plan as premium (the shape a real gateway would produce)', async () => {
      const periodEnd = new Date('2026-08-25T00:00:00.000Z');
      prisma.subscription.findUnique.mockResolvedValue({
        ...makeSubscription({
          planId: PREMIUM_PLAN.id,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: true,
        }),
        plan: PREMIUM_PLAN,
      });

      const result = await service.getSubscription('user-1');

      expect(result.isPremium).toBe(true);
      expect(result.currentPeriodEnd).toBe(periodEnd);
      expect(result.cancelAtPeriodEnd).toBe(true);
      expect(result.entitlements.entitledPlanCode).toBe(PREMIUM_PLAN_CODE);
      expect(result.entitlements.limits.trustedContacts).toBeNull();
      expect(result.entitlements.capabilities.prioritySos).toBe(true);
    });

    it('fails loudly when the free plan is missing from the catalog', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);
      prisma.plan.findUnique.mockResolvedValue(null);

      await expect(service.getSubscription('user-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('selectPlan', () => {
    it('records a PAID plan as PENDING — never ACTIVE — and says payments are not live', async () => {
      prisma.plan.findFirst.mockResolvedValue(PREMIUM_PLAN);
      prisma.subscription.upsert.mockImplementation(
        (args: { create: Partial<Subscription> }) =>
          Promise.resolve(makeSubscription(args.create)),
      );

      const result = await service.selectPlan('user-1', PREMIUM_PLAN_CODE);

      expect(result.status).toBe(SubscriptionStatus.PENDING);
      expect(result.status).not.toBe(SubscriptionStatus.ACTIVE);
      expect(result.isPremium).toBe(false);
      expect(result.paymentAvailable).toBe(false);
      expect(result.message).toMatch(/payments aren't available yet/i);
      expect(result.message).toMatch(/nothing has been charged/i);

      // The persisted row must carry PENDING and no paid period whatsoever.
      const upsertArgs = (
        prisma.subscription.upsert.mock.calls as Array<
          [{ where: unknown; create: Partial<Subscription> }]
        >
      )[0][0];
      expect(upsertArgs.where).toEqual({ userId: 'user-1' });
      expect(upsertArgs.create).toEqual(
        expect.objectContaining({
          userId: 'user-1',
          planId: PREMIUM_PLAN.id,
          status: SubscriptionStatus.PENDING,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        }),
      );
    });

    it('makes the FREE plan effective immediately', async () => {
      prisma.plan.findFirst.mockResolvedValue(makePlan());
      prisma.subscription.upsert.mockImplementation(
        (args: { create: Partial<Subscription> }) =>
          Promise.resolve(makeSubscription(args.create)),
      );

      const result = await service.selectPlan('user-1', FREE_PLAN_CODE);

      expect(result.status).toBe(SubscriptionStatus.FREE);
      expect(result.isPremium).toBe(false);
      expect(result.message).toMatch(/free plan/i);

      const upsertArgs = (
        prisma.subscription.upsert.mock.calls as Array<
          [{ create: { currentPeriodStart: Date | null } }]
        >
      )[0][0];
      expect(upsertArgs.create.currentPeriodStart).toBeInstanceOf(Date);
    });

    it('rejects an unknown plan code with the codes that do exist, and writes nothing', async () => {
      prisma.plan.findFirst.mockResolvedValue(null);
      prisma.plan.findMany.mockResolvedValue([
        { code: FREE_PLAN_CODE },
        { code: PREMIUM_PLAN_CODE },
      ]);

      await expect(service.selectPlan('user-1', 'enterprise')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.selectPlan('user-1', 'enterprise')).rejects.toThrow(
        /free, premium/,
      );
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('normalizes case and surrounding whitespace before the catalog lookup', async () => {
      prisma.plan.findFirst.mockResolvedValue(PREMIUM_PLAN);
      prisma.subscription.upsert.mockResolvedValue(
        makeSubscription({
          planId: PREMIUM_PLAN.id,
          status: SubscriptionStatus.PENDING,
        }),
      );

      await service.selectPlan('user-1', '  PREMIUM  ');

      expect(prisma.plan.findFirst).toHaveBeenCalledWith({
        where: { code: PREMIUM_PLAN_CODE, isActive: true },
      });
    });

    it('keeps one row per user when two first-time selections race (P2002 → update)', async () => {
      prisma.plan.findFirst.mockResolvedValue(PREMIUM_PLAN);
      prisma.subscription.upsert.mockRejectedValue(uniqueViolation());
      prisma.subscription.update.mockResolvedValue(
        makeSubscription({
          planId: PREMIUM_PLAN.id,
          status: SubscriptionStatus.PENDING,
        }),
      );

      const result = await service.selectPlan('user-1', PREMIUM_PLAN_CODE);

      expect(prisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } }),
      );
      expect(result.status).toBe(SubscriptionStatus.PENDING);
    });

    it('rethrows unexpected database errors instead of swallowing them', async () => {
      prisma.plan.findFirst.mockResolvedValue(PREMIUM_PLAN);
      prisma.subscription.upsert.mockRejectedValue(new Error('pool exhausted'));

      await expect(
        service.selectPlan('user-1', PREMIUM_PLAN_CODE),
      ).rejects.toThrow('pool exhausted');
    });
  });

  describe('createPortalLink', () => {
    it('builds the account URL from WEB_APP_URL with a single-use token and its expiry', async () => {
      const result = await service.createPortalLink('user-1');

      expect(handoffTokens.issue).toHaveBeenCalledWith('user-1');
      // Trailing slash on WEB_APP_URL must not produce a double slash.
      expect(result.url).toBe(
        'https://roamwarden.example/account?handoff=handoff-token-value',
      );
      expect(result.expiresAt).toEqual(new Date('2026-07-25T00:05:00.000Z'));
    });

    it('URL-encodes the token so base64url padding can never break the query', async () => {
      handoffTokens.issue.mockResolvedValue({
        token: 'a+b/c=d&e',
        expiresAt: new Date('2026-07-25T00:05:00.000Z'),
      });

      const result = await service.createPortalLink('user-1');

      expect(result.url).toContain('handoff=a%2Bb%2Fc%3Dd%26e');
    });

    it('falls back to API_BASE_URL when WEB_APP_URL is unset', async () => {
      build({ WEB_APP_URL: undefined });

      const result = await service.createPortalLink('user-1');

      expect(result.url).toBe(
        'https://api.roamwarden.example/account?handoff=handoff-token-value',
      );
    });
  });

  describe('isPremium', () => {
    it('is false for a user with no subscription row', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);

      await expect(service.isPremium('user-1')).resolves.toBe(false);
    });

    it('is false while a paid plan is only PENDING (nobody paid)', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        status: SubscriptionStatus.PENDING,
        plan: { code: PREMIUM_PLAN_CODE },
      });

      await expect(service.isPremium('user-1')).resolves.toBe(false);
    });

    it('is true only for an ACTIVE paid plan', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        status: SubscriptionStatus.ACTIVE,
        plan: { code: PREMIUM_PLAN_CODE },
      });

      await expect(service.isPremium('user-1')).resolves.toBe(true);
    });
  });

  describe('getEntitlements', () => {
    it('returns the free limits for a user with no subscription row, unenforced', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);

      const result = await service.getEntitlements('user-1');

      expect(result.planCode).toBe(FREE_PLAN_CODE);
      expect(result.limits.trustedContacts).toBe(5);
      expect(result.limits.tripHistoryDays).toBe(30);
      // The whole point: the server is not capping anything yet.
      expect(result.enforced).toBe(false);
    });

    it('drops the cached entitlements when the plan changes, so the next read is fresh', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);
      await service.getEntitlements('user-1');

      prisma.plan.findFirst.mockResolvedValue(PREMIUM_PLAN);
      prisma.subscription.upsert.mockResolvedValue(
        makeSubscription({
          planId: PREMIUM_PLAN.id,
          status: SubscriptionStatus.PENDING,
        }),
      );
      await service.selectPlan('user-1', PREMIUM_PLAN_CODE);

      prisma.subscription.findUnique.mockResolvedValue({
        status: SubscriptionStatus.PENDING,
        plan: { code: PREMIUM_PLAN_CODE },
      });
      const after = await service.getEntitlements('user-1');

      expect(after.planCode).toBe(PREMIUM_PLAN_CODE);
      expect(prisma.subscription.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('isPremiumEntitled', () => {
    it('treats "no subscription row" as the free tier', () => {
      expect(isPremiumEntitled(null)).toBe(false);
    });

    it('never grants premium on the free plan, whatever the status says', () => {
      expect(
        isPremiumEntitled({
          planCode: FREE_PLAN_CODE,
          status: SubscriptionStatus.ACTIVE,
        }),
      ).toBe(false);
    });

    it('grants premium for a paid plan only when ACTIVE', () => {
      const statuses: SubscriptionStatus[] = [
        SubscriptionStatus.FREE,
        SubscriptionStatus.PENDING,
        SubscriptionStatus.CANCELLED,
        SubscriptionStatus.EXPIRED,
      ];
      for (const status of statuses) {
        expect(isPremiumEntitled({ planCode: PREMIUM_PLAN_CODE, status })).toBe(
          false,
        );
      }
      expect(
        isPremiumEntitled({
          planCode: PREMIUM_PLAN_CODE,
          status: SubscriptionStatus.ACTIVE,
        }),
      ).toBe(true);
    });
  });
});
