import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  FREE_PLAN_CODE,
  PREMIUM_PLAN_CODE,
} from '../../resources/billing/constant/billing.constants';
import { isPremiumEntitled } from '../../resources/billing/entitlements';
import {
  ENFORCE_PLAN_LIMITS_ENV,
  ENTITLEMENTS_CACHE_MAX_ENTRIES,
  ENTITLEMENTS_CACHE_TTL_MS,
  PLAN_CAPABILITY_ERROR_CODE,
  PLAN_ENTITLEMENTS,
  PLAN_LIMIT_ERROR_CODE,
  SHADOW_LOG_PREFIX,
  capabilityRequiredMessage,
  limitReachedMessage,
} from './entitlement.constants';
import type {
  CapabilityCheck,
  CapabilityKey,
  CountLimitKey,
  Entitlements,
  LimitCheck,
  PlanEntitlements,
  WindowCheck,
  WindowLimitKey,
} from './entitlement.types';

/** What a subscription row tells us, reduced to the two fields that matter. */
interface SubscriptionFacts {
  planCode: string;
  status: SubscriptionStatus;
}

interface CacheEntry {
  expiresAt: number;
  value: Promise<Entitlements>;
}

/**
 * The ONE service the rest of the backend asks about plans (build plan §20).
 *
 * ─────────────────────────── READ THIS BEFORE USING ───────────────────────────
 * ENFORCEMENT IS OFF BY DEFAULT (ENFORCE_PLAN_LIMITS). While it is off:
 *   • `assertWithinLimit` / `assertCapability` NEVER throw;
 *   • `WindowCheck.since` is always null, so no query is narrowed;
 *   • every user keeps everything they can do today.
 * The checks still compute, and REPORT, what they WOULD have blocked
 * (`wouldBlock`, plus a debug log tagged `[plan-limits][shadow]`). That signal is
 * the point: you can measure the blast radius of the flag before flipping it.
 *
 * There is no payment gateway, so nobody can be ACTIVE, so enforcing today would
 * only ever remove capabilities that users cannot buy back. When billing ships,
 * ENFORCE_PLAN_LIMITS=true is the whole rollout.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Resolution rules:
 *   • No subscription row → the FREE plan (that is what "no row" means).
 *   • A paid plan grants its limits ONLY while ACTIVE — PENDING/CANCELLED/
 *     EXPIRED all resolve to FREE limits, via `isPremiumEntitled`.
 *   • A catalog code with no row in PLAN_ENTITLEMENTS falls back to FREE (or to
 *     PREMIUM if the user is entitled, so a new paid tier can never strip a
 *     paying user) and logs an error naming the code.
 */
@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  /** The switch. False unless ENFORCE_PLAN_LIMITS is exactly 'true'. */
  private readonly enforce: boolean;

  /** userId → in-flight/recent entitlements. Plain Map: no cache dependency. */
  private readonly cache = new Map<string, CacheEntry>();

  /** Plan codes we have already complained about, so logs stay readable. */
  private readonly warnedUnknownPlanCodes = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.enforce = parseEnforcementFlag(
      config.get<string>(ENFORCE_PLAN_LIMITS_ENV),
    );
    if (this.enforce) {
      // Loud on purpose: this is the only setting in the system that can take a
      // capability away from an existing user.
      this.logger.warn(
        `${ENFORCE_PLAN_LIMITS_ENV}=true — plan limits are ENFORCED. Users over a Free limit will now be blocked. Turn it off to restore everyone immediately.`,
      );
    } else {
      this.logger.log(
        `${ENFORCE_PLAN_LIMITS_ENV} is off — plan limits are advisory only: nothing is capped or blocked. Would-be blocks are logged at debug with "${SHADOW_LOG_PREFIX}".`,
      );
    }
  }

  /** Whether limits are being enforced right now. */
  isEnforced(): boolean {
    return this.enforce;
  }

  /**
   * The caller's resolved entitlements. This is the API other modules use.
   *
   * Throws only if the database read itself fails (the billing endpoints want
   * to know). The `check*`/`assert*` helpers below swallow that failure and
   * fail OPEN instead — an entitlement lookup must never break a safety feature.
   */
  async getEntitlements(userId: string): Promise<Entitlements> {
    const cached = this.readCache(userId);
    if (cached) return cached;

    const pending = this.load(userId);
    this.writeCache(userId, pending);
    try {
      return await pending;
    } catch (error) {
      // Never leave a rejected lookup memoized.
      this.cache.delete(userId);
      throw error;
    }
  }

  /**
   * Resolves entitlements from a subscription row the caller ALREADY has, with
   * no database round-trip. `null` = no row = the free tier.
   */
  entitlementsFor(subscription: SubscriptionFacts | null): Entitlements {
    const planCode = subscription?.planCode ?? FREE_PLAN_CODE;
    const status = subscription?.status ?? SubscriptionStatus.FREE;
    const isPremium = isPremiumEntitled(subscription);
    const entitledPlanCode = isPremium ? planCode : FREE_PLAN_CODE;
    const plan = this.planEntitlements(entitledPlanCode, isPremium);
    return {
      planCode,
      entitledPlanCode,
      status,
      isPremium,
      limits: plan.limits,
      capabilities: plan.capabilities,
      enforced: this.enforce,
    };
  }

  /**
   * What a CATALOG plan includes, regardless of who is asking — for pricing
   * pages and plan comparison. This is not a grant: never use it to decide what
   * a user may do (that is `getEntitlements`).
   */
  planEntitlements(
    planCode: string,
    entitledFallback = false,
  ): PlanEntitlements {
    const plan = PLAN_ENTITLEMENTS[planCode];
    if (plan) return plan;
    if (!this.warnedUnknownPlanCodes.has(planCode)) {
      this.warnedUnknownPlanCodes.add(planCode);
      this.logger.error(
        `Plan "${planCode}" has no entry in PLAN_ENTITLEMENTS — falling back to the ${
          entitledFallback ? PREMIUM_PLAN_CODE : FREE_PLAN_CODE
        } tier. Add it to src/common/entitlements/entitlement.constants.ts.`,
      );
    }
    // An entitled (paid, ACTIVE) user must never be silently downgraded by a
    // missing table entry, so they get the premium tier until it is fixed.
    return PLAN_ENTITLEMENTS[
      entitledFallback ? PREMIUM_PLAN_CODE : FREE_PLAN_CODE
    ];
  }

  /**
   * "May this user have one more?" — the read-only form. NEVER throws.
   *
   * @param currentCount how many the user has RIGHT NOW, before adding one.
   *   The question asked is `currentCount < limit`.
   */
  async checkLimit(
    userId: string,
    key: CountLimitKey,
    currentCount: number,
  ): Promise<LimitCheck> {
    const entitlements = await this.resolveForCheck(userId, key);
    const limit = entitlements.limits[key];
    const current = normalizeCount(currentCount);
    const wouldBlock = limit !== null && current >= limit;
    const check: LimitCheck = {
      key,
      planCode: entitlements.entitledPlanCode,
      enforced: entitlements.enforced,
      limit,
      current,
      remaining: limit === null ? null : Math.max(0, limit - current),
      allowed: !entitlements.enforced || !wouldBlock,
      wouldBlock,
      message: wouldBlock ? limitReachedMessage(key, limit ?? 0) : null,
    };
    if (wouldBlock && !entitlements.enforced) {
      this.logger.debug(
        `${SHADOW_LOG_PREFIX} would have blocked user ${userId}: ${key} ${current}/${String(limit)} on plan "${check.planCode}" (allowed — enforcement is off)`,
      );
    }
    return check;
  }

  /**
   * The guard other modules call before adding something.
   *
   * With the switch OFF this ALWAYS returns and never throws — it just reports
   * `wouldBlock`. With it ON, an over-limit call throws 403 carrying a human
   * message plus `code: 'PLAN_LIMIT_REACHED'` and the numbers, so a client can
   * render an upgrade prompt without parsing prose.
   */
  async assertWithinLimit(
    userId: string,
    key: CountLimitKey,
    currentCount: number,
  ): Promise<LimitCheck> {
    const check = await this.checkLimit(userId, key, currentCount);
    if (!check.allowed) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: check.message,
        code: PLAN_LIMIT_ERROR_CODE,
        limitKey: check.key,
        limit: check.limit,
        current: check.current,
        planCode: check.planCode,
        upgradeTo: PREMIUM_PLAN_CODE,
      });
    }
    return check;
  }

  /** "Does this user's plan include X?" — read-only form. NEVER throws. */
  async checkCapability(
    userId: string,
    key: CapabilityKey,
  ): Promise<CapabilityCheck> {
    const entitlements = await this.resolveForCheck(userId, key);
    const granted = entitlements.capabilities[key];
    const check: CapabilityCheck = {
      key,
      planCode: entitlements.entitledPlanCode,
      enforced: entitlements.enforced,
      granted,
      allowed: !entitlements.enforced || granted,
      wouldBlock: !granted,
      message: granted ? null : capabilityRequiredMessage(key),
    };
    if (!granted && !entitlements.enforced) {
      this.logger.debug(
        `${SHADOW_LOG_PREFIX} would have blocked user ${userId}: capability "${key}" is not in plan "${check.planCode}" (allowed — enforcement is off)`,
      );
    }
    return check;
  }

  /** Capability guard. Throws 403 ONLY while enforcement is on. */
  async assertCapability(
    userId: string,
    key: CapabilityKey,
  ): Promise<CapabilityCheck> {
    const check = await this.checkCapability(userId, key);
    if (!check.allowed) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: check.message,
        code: PLAN_CAPABILITY_ERROR_CODE,
        capability: check.key,
        planCode: check.planCode,
        upgradeTo: PREMIUM_PLAN_CODE,
      });
    }
    return check;
  }

  /**
   * "How far back may this user read?" — for window limits like trip history.
   * NEVER throws, and while enforcement is off `since` is always null, so the
   * caller's query returns exactly what it returns today.
   *
   * Use it as: `where: { startedAt: since ? { gte: since } : undefined }`.
   */
  async getWindow(userId: string, key: WindowLimitKey): Promise<WindowCheck> {
    const entitlements = await this.resolveForCheck(userId, key);
    const windowDays = entitlements.limits[key];
    const wouldApplySince =
      windowDays === null
        ? null
        : new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    if (wouldApplySince && !entitlements.enforced) {
      this.logger.debug(
        `${SHADOW_LOG_PREFIX} would have narrowed user ${userId}: ${key} to ${String(windowDays)} days on plan "${entitlements.entitledPlanCode}" (not applied — enforcement is off)`,
      );
    }
    return {
      key,
      planCode: entitlements.entitledPlanCode,
      enforced: entitlements.enforced,
      windowDays,
      since: entitlements.enforced ? wouldApplySince : null,
      wouldApplySince,
    };
  }

  /**
   * Drops a user's memoized entitlements. Call after changing their plan so the
   * next read is fresh (BillingService.selectPlan does).
   */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  /** Drops the whole memo (tests, and any bulk plan change). */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Entitlements for a gate. Unlike `getEntitlements` this NEVER throws: if the
   * lookup fails we fail OPEN — free limits, `enforced: false` — so a database
   * hiccup can never block an SOS, a contact or a trip. The warning says so.
   */
  private async resolveForCheck(
    userId: string,
    key: string,
  ): Promise<Entitlements> {
    try {
      return await this.getEntitlements(userId);
    } catch (error) {
      this.logger.warn(
        `Could not resolve entitlements for user ${userId} while checking "${key}" — allowing the action (fail-open): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { ...this.entitlementsFor(null), enforced: false };
    }
  }

  private async load(userId: string): Promise<Entitlements> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { userId },
      select: { status: true, plan: { select: { code: true } } },
    });
    return this.entitlementsFor(
      subscription
        ? { planCode: subscription.plan.code, status: subscription.status }
        : null,
    );
  }

  private readCache(userId: string): Promise<Entitlements> | null {
    const entry = this.cache.get(userId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(userId);
      return null;
    }
    return entry.value;
  }

  private writeCache(userId: string, value: Promise<Entitlements>): void {
    // Bounded: evict the oldest insertion (Map preserves insertion order) so a
    // traffic burst cannot grow this without limit.
    if (this.cache.size >= ENTITLEMENTS_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(userId, {
      expiresAt: Date.now() + ENTITLEMENTS_CACHE_TTL_MS,
      value,
    });
  }
}

/**
 * Only the exact string 'true' (trimmed, any case) turns enforcement on.
 * Anything else — unset, empty, '1', 'yes', a typo — means OFF, because the
 * safe answer to an ambiguous value here is "do not take features away".
 */
export function parseEnforcementFlag(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

/** Defensive: a caller's count must never turn into NaN maths. */
function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}
