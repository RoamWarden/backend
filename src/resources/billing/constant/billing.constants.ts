import { SubscriptionStatus } from '@prisma/client';

/**
 * The two plan codes that exist today (build plan §20). These are the ONLY
 * hardcoded strings about plans anywhere in the codebase — everything else
 * (name, price, copy, features) is a seeded `plans` row so it can change without
 * an app, web or API deploy. B2B duty-of-care tiers come later.
 */
export const FREE_PLAN_CODE = 'free';
export const PREMIUM_PLAN_CODE = 'premium';

/** Longest plan code we will even look up (DTO guard, not a business rule). */
export const PLAN_CODE_MAX_LENGTH = 40;

/**
 * Statuses that actually grant paid entitlements. ONLY `ACTIVE` counts —
 * PENDING means "chose a paid plan, paid nothing", so it must never unlock a
 * feature. Nothing in this codebase may write ACTIVE for a paid plan while
 * there is no payment gateway.
 */
export const ENTITLED_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
];

/**
 * Path of the web account area the app hands users off to. The host comes from
 * WEB_APP_URL — never hardcode a domain.
 */
export const WEB_ACCOUNT_PATH = '/account';

/** Query parameter that carries the single-use hand-off token on that URL. */
export const HANDOFF_QUERY_PARAM = 'handoff';

/**
 * Shown whenever someone selects a paid plan. THERE IS NO PAYMENT GATEWAY YET:
 * the selection is recorded as PENDING, nobody is charged, and nobody gets paid
 * features. The message must say so plainly rather than imply a pending charge.
 */
export const PAYMENTS_UNAVAILABLE_MESSAGE =
  "Payments aren't available yet, so nothing has been charged. We've saved your interest in Premium and will email you the moment checkout opens.";

/** Shown when someone (re)selects the free plan. */
export const FREE_PLAN_SELECTED_MESSAGE =
  "You're on the Free plan — core alerts, basic trip sharing and SOS, at no cost.";
