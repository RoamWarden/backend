import { SubscriptionStatus } from '@prisma/client';
import {
  ENTITLED_STATUSES,
  FREE_PLAN_CODE,
} from './constant/billing.constants';

/**
 * The ONE place that answers "is this user premium?".
 *
 * Feature gates must call this (via `BillingService.isPremium`) instead of
 * comparing statuses themselves, so the answer can never drift between call
 * sites. Nothing is gated on it yet — wiring it into existing features is a
 * separate change, because switching a gate on today would take capabilities
 * away from current users.
 *
 * Rules, in order:
 * - No subscription row at all → free tier (that is what "no row" means).
 * - The free plan is never premium, whatever its status says.
 * - A paid plan is premium ONLY while ACTIVE. PENDING (chose a paid plan, paid
 *   nothing — the only paid state possible before a gateway exists), CANCELLED
 *   and EXPIRED all grant nothing.
 */
export function isPremiumEntitled(
  subscription: { planCode: string; status: SubscriptionStatus } | null,
): boolean {
  if (!subscription) return false;
  if (subscription.planCode === FREE_PLAN_CODE) return false;
  return ENTITLED_STATUSES.includes(subscription.status);
}
