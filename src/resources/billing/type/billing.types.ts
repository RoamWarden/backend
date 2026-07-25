import type { SubscriptionStatus } from '@prisma/client';
import type {
  Entitlements,
  PlanCapabilities,
  PlanLimits,
} from '../../../common/entitlements';

/** Response shapes for the billing API (build plan §20). */

/**
 * A plan as clients see it. Keyed by `code` — the database id is deliberately
 * NOT exposed, so nothing outside the backend can pin itself to a row id.
 */
export interface PlanView {
  /** Stable identifier used by every client and by POST /billing/subscription. */
  code: string;
  name: string;
  description: string;
  /** Price in the smallest currency unit (cents). 0 = free. */
  priceAmountMinor: number;
  /** ISO-4217 code, e.g. 'USD'. */
  currency: string;
  /** Billing cadence of the price, e.g. 'month'. */
  interval: string;
  /**
   * Ready-to-render price, formatted server-side so the app and the website can
   * never disagree: 'Free' when the plan costs nothing, otherwise e.g. '$5.00'.
   * Clients append the cadence themselves ('/mo').
   */
  priceFormatted: string;
  /** Marketing bullets, rendered verbatim in plan order. */
  features: string[];
  /** Display order, ascending. The catalog is already sorted by it. */
  sortOrder: number;
  /**
   * What this plan INCLUDES, straight from the server's limits table — so a
   * pricing page can render an exact comparison ("5 contacts" vs "Unlimited")
   * instead of restating numbers in client code. `null` = unlimited.
   *
   * This is catalog information about the plan, NOT a grant to the caller: what
   * the CALLER may do is `SubscriptionView.entitlements`.
   */
  limits: PlanLimits;
  /** Boolean features this plan includes. Same caveat as `limits`. */
  capabilities: PlanCapabilities;
}

/** GET /billing/plans — the public catalog. */
export interface PlanCatalogResult {
  plans: PlanView[];
}

/** GET /billing/subscription — the caller's resolved plan state. */
export interface SubscriptionView {
  plan: PlanView;
  status: SubscriptionStatus;
  /** null for free/pending — there is no paid period to end. */
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Whether paid features are unlocked. Always false while PENDING. */
  isPremium: boolean;
  /**
   * Whether checkout is live. Hardcoded false until a payment gateway exists —
   * clients use it to render the "Pay now" button as visibly inert.
   */
  paymentAvailable: boolean;
  /**
   * What the CALLER may do: resolved limits, capabilities, and whether the
   * server enforces them at all. Identical shape to GET /billing/entitlements,
   * so clients model it once.
   *
   * While `entitlements.enforced` is false (the shipping state) clients MUST
   * NOT cap, hide, lock or remove anything — show the numbers as information
   * ("Free includes 5 trusted contacts"), never as a block.
   */
  entitlements: EntitlementsView;
}

/**
 * GET /billing/entitlements — the caller's plan capabilities on their own.
 * Structurally identical to `SubscriptionView.entitlements`.
 */
export type EntitlementsView = Entitlements;

/** POST /billing/subscription — the new state plus a line to show the user. */
export interface SelectPlanResult extends SubscriptionView {
  message: string;
}

/** POST /billing/portal-link — one-shot URL into the web account area. */
export interface PortalLinkResult {
  url: string;
  expiresAt: Date;
}
