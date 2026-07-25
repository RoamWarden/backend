import {
  FREE_PLAN_CODE,
  PREMIUM_PLAN_CODE,
} from '../../resources/billing/constant/billing.constants';
import type {
  CapabilityKey,
  CountLimitKey,
  LimitValue,
  PlanEntitlements,
  WindowLimitKey,
} from './entitlement.types';

/**
 * THE plan-limits table (build plan §20).
 *
 * One table, keyed by the plan `code` that lives in the `plans` catalog, is the
 * only place a number about a plan may appear. Call sites never hardcode "5" or
 * "30 days" — they ask EntitlementsService and read the value back, so changing
 * a tier is a one-line edit here instead of a hunt through five modules.
 *
 * Adding a plan later (e.g. a B2B tier) = insert the catalog row + add its entry
 * below. Nothing else changes.
 *
 * NONE OF THESE NUMBERS TAKE ANYTHING AWAY TODAY. They are only enforced when
 * ENFORCE_PLAN_LIMITS is true, which defaults to false (see EntitlementsService).
 */

/** A limit that is not a limit. Always `null` — see `LimitValue`. */
export const UNLIMITED: LimitValue = null;

/**
 * Free-tier numbers, and WHY they are what they are.
 *
 * The product promise is that CORE SAFETY IS FREE ("Core alerts, basic trip
 * sharing, SOS" — build plan §20). A free tier that a normal, careful traveller
 * bumps into is a broken promise, so each number below is set ABOVE ordinary
 * personal use and Premium sells scale, history and extras — never safety.
 */

/**
 * 5 trusted contacts on Free.
 *
 * Real emergency-contact lists are 2–3 people: a partner, a parent, one close
 * friend. 5 covers a household plus a friend with room to spare, so an ordinary
 * user never meets this number, while "unlimited" stays a genuine reason to pay
 * for people who manage large groups (tour operators, big families, guides).
 * It also bounds SOS fan-out cost per user, which scales linearly with contacts.
 */
const FREE_TRUSTED_CONTACTS = 5;

/**
 * 30 days of trip history on Free.
 *
 * A window, not a count: a count would silently hide a heavy user's RECENT
 * trips, which is exactly the wrong thing to lose in a safety app, whereas a
 * window is predictable ("the last month") and explains itself in the UI. A
 * month covers the only everyday question — "where did I go last week / show me
 * that trip" — while analytics across seasons and years is the Premium story.
 */
const FREE_TRIP_HISTORY_DAYS = 30;

/**
 * Family/group plan members. Free is 0 because the family plan is a Premium
 * feature outright; Premium is 6 INCLUDING the owner — a household, not a
 * distribution list (an unbounded "family" is a licence to share one account).
 */
const FREE_FAMILY_MEMBERS = 0;
const PREMIUM_FAMILY_MEMBERS = 6;

/**
 * Frozen because these objects are handed out by reference to every module and
 * serialized into API responses: one stray mutation would silently change the
 * plan for the whole process.
 */
function freezePlan(plan: PlanEntitlements): PlanEntitlements {
  Object.freeze(plan.limits);
  Object.freeze(plan.capabilities);
  return Object.freeze(plan);
}

/**
 * Plan code → what that plan includes. Keys must match `plans.code` rows.
 */
export const PLAN_ENTITLEMENTS: Record<string, PlanEntitlements> = {
  [FREE_PLAN_CODE]: freezePlan({
    limits: {
      trustedContacts: FREE_TRUSTED_CONTACTS,
      tripHistoryDays: FREE_TRIP_HISTORY_DAYS,
      familyMembers: FREE_FAMILY_MEMBERS,
    },
    capabilities: {
      analytics: false,
      prioritySos: false,
      familyPlan: false,
      offlineMaps: false,
    },
  }),
  [PREMIUM_PLAN_CODE]: freezePlan({
    limits: {
      trustedContacts: UNLIMITED,
      tripHistoryDays: UNLIMITED,
      familyMembers: PREMIUM_FAMILY_MEMBERS,
    },
    capabilities: {
      analytics: true,
      prioritySos: true,
      familyPlan: true,
      offlineMaps: true,
    },
  }),
};

/**
 * Env var that turns ENFORCEMENT on. Absent/anything-but-'true' → OFF, which is
 * the shipping state: there is no payment gateway, so nobody can be ACTIVE, so
 * enforcing would only ever take capabilities away from users who cannot buy
 * them back. One flag flip is the entire rollout.
 */
export const ENFORCE_PLAN_LIMITS_ENV = 'ENFORCE_PLAN_LIMITS';

/**
 * How long a resolved entitlement is reused (ms). Long enough to collapse the
 * several checks a single request makes into ONE query, short enough that a
 * plan change is visible almost immediately. `BillingService.selectPlan` also
 * invalidates the entry outright, so this only bounds changes made elsewhere.
 */
export const ENTITLEMENTS_CACHE_TTL_MS = 5000;

/** Hard bound on the memo so a burst of traffic cannot grow it without limit. */
export const ENTITLEMENTS_CACHE_MAX_ENTRIES = 5000;

/** Prefix on every shadow-mode log line, so the impact of flipping the flag is greppable. */
export const SHADOW_LOG_PREFIX = '[plan-limits][shadow]';

/** Machine-readable `code` on the 403 body when a limit is enforced. */
export const PLAN_LIMIT_ERROR_CODE = 'PLAN_LIMIT_REACHED';

/** Machine-readable `code` on the 403 body when a capability is enforced. */
export const PLAN_CAPABILITY_ERROR_CODE = 'PLAN_UPGRADE_REQUIRED';

/** Human nouns for the countable limits, used in blocked-message copy. */
const COUNT_LIMIT_NOUNS: Record<CountLimitKey, string> = {
  trustedContacts: 'trusted contacts',
  familyMembers: 'family members',
};

/** Human names for capabilities, used in blocked-message copy. */
const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  analytics: 'Trip history & analytics',
  prioritySos: 'Priority SOS',
  familyPlan: 'The family & group plan',
  offlineMaps: 'Offline maps',
};

/** Human names for the window limits, for UI copy. */
const WINDOW_LIMIT_LABELS: Record<WindowLimitKey, string> = {
  tripHistoryDays: 'trip history',
};

/**
 * The message a user sees when a countable limit blocks them. Never a bare
 * status code — it says what happened, and the two ways out (make room, or
 * upgrade). These strings can only ever reach a user once ENFORCE_PLAN_LIMITS
 * is on, which implies checkout exists.
 */
export function limitReachedMessage(key: CountLimitKey, limit: number): string {
  const noun = COUNT_LIMIT_NOUNS[key];
  if (limit <= 0) {
    return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} are part of Premium. Upgrade to add them.`;
  }
  return `You've reached your plan's limit of ${limit} ${noun}. Remove one to add another, or upgrade to Premium.`;
}

/** The message a user sees when a capability blocks them. */
export function capabilityRequiredMessage(key: CapabilityKey): string {
  return `${CAPABILITY_LABELS[key]} is part of Premium. Upgrade to unlock it.`;
}

/** Label for a window limit, for callers building their own UI copy. */
export function windowLimitLabel(key: WindowLimitKey): string {
  return WINDOW_LIMIT_LABELS[key];
}
