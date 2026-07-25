import type { SubscriptionStatus } from '@prisma/client';

/**
 * Types for the plan-entitlement system (build plan §20).
 *
 * Read this first: entitlements describe what a plan INCLUDES. They do not, on
 * their own, take anything away — `enforced` decides that, and it is off by
 * default (see ENFORCE_PLAN_LIMITS). Every shape below is JSON-safe so the same
 * object can be returned straight to clients.
 */

/** Limits expressed as "how many of X may this user have". */
export type CountLimitKey = 'trustedContacts' | 'familyMembers';

/** Limits expressed as "how far back may this user see" (in days). */
export type WindowLimitKey = 'tripHistoryDays';

export type LimitKey = CountLimitKey | WindowLimitKey;

/** Boolean features a plan either includes or does not. */
export type CapabilityKey =
  'analytics' | 'prioritySos' | 'familyPlan' | 'offlineMaps';

/**
 * A numeric limit, or `null` for UNLIMITED.
 *
 * `null` — never `Infinity` or `-1`: `JSON.stringify(Infinity)` is `null`
 * anyway, so `null` is the only value that survives the wire unchanged and
 * means the same thing on the server, in the app and on the website.
 */
export type LimitValue = number | null;

export type PlanLimits = Record<LimitKey, LimitValue>;

export type PlanCapabilities = Record<CapabilityKey, boolean>;

/** What one plan in the catalog includes. */
export interface PlanEntitlements {
  limits: PlanLimits;
  capabilities: PlanCapabilities;
}

/**
 * A user's resolved entitlements — the object `getEntitlements(userId)` returns
 * and the exact JSON clients receive from `GET /billing/entitlements`.
 */
export interface Entitlements extends PlanEntitlements {
  /** The plan recorded on the subscription row ('free' when there is no row). */
  planCode: string;
  /**
   * The plan whose `limits`/`capabilities` actually apply. This is 'free' for
   * everyone except an ACTIVE paid subscriber — a PENDING premium selection
   * grants nothing, because nobody has paid.
   */
  entitledPlanCode: string;
  status: SubscriptionStatus;
  /** `entitledPlanCode !== 'free'`. Mirrors `isPremiumEntitled`. */
  isPremium: boolean;
  /**
   * Whether the server ENFORCES these limits right now (ENFORCE_PLAN_LIMITS).
   * While false, nothing is capped, hidden or blocked anywhere — clients must
   * render limits as information only, never as a lock.
   */
  enforced: boolean;
}

/** Result of asking "may this user have one more X?". Never a bare boolean. */
export interface LimitCheck {
  key: CountLimitKey;
  /** The plan the numbers below came from (the entitled plan). */
  planCode: string;
  enforced: boolean;
  /** null = unlimited. */
  limit: LimitValue;
  /** What the caller reported the user has right now. */
  current: number;
  /** How many more they may add; null = unlimited. Never negative. */
  remaining: LimitValue;
  /** May the caller proceed? ALWAYS true while `enforced` is false. */
  allowed: boolean;
  /**
   * Would this have been blocked if enforcement were on? This is the signal
   * that makes the flag safe to flip: it shows the impact before enabling it.
   */
  wouldBlock: boolean;
  /** Human message to show when blocking. null when nothing is wrong. */
  message: string | null;
}

/** Result of asking "does this user's plan include feature X?". */
export interface CapabilityCheck {
  key: CapabilityKey;
  planCode: string;
  enforced: boolean;
  /** Does the plan actually include it? */
  granted: boolean;
  /** May the caller proceed? ALWAYS true while `enforced` is false. */
  allowed: boolean;
  /** Would this have been blocked if enforcement were on? */
  wouldBlock: boolean;
  message: string | null;
}

/** Result of asking "how far back may this user read?". */
export interface WindowCheck {
  key: WindowLimitKey;
  planCode: string;
  enforced: boolean;
  /** The plan's window in days; null = unlimited. */
  windowDays: LimitValue;
  /**
   * The cutoff to APPLY in the query. `null` means "no cutoff, return
   * everything" — which is the case both for an unlimited plan AND whenever
   * enforcement is off. Callers use exactly this field, so turning the flag on
   * or off needs no code change.
   */
  since: Date | null;
  /**
   * The cutoff that WOULD apply if enforcement were on (null when unlimited).
   * Safe to show in the UI ("Free shows the last 30 days") while `since` is
   * null — showing is not the same as hiding.
   */
  wouldApplySince: Date | null;
}
