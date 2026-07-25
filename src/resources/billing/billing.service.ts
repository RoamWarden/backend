import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import type { Plan, Subscription } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { HandoffTokenService } from '../auth/handoff-token.service';
import {
  FREE_PLAN_CODE,
  FREE_PLAN_SELECTED_MESSAGE,
  HANDOFF_QUERY_PARAM,
  PAYMENTS_UNAVAILABLE_MESSAGE,
  WEB_ACCOUNT_PATH,
} from './constant/billing.constants';
import { isPremiumEntitled } from './entitlements';
import type {
  PlanCatalogResult,
  PlanView,
  PortalLinkResult,
  SelectPlanResult,
  SubscriptionView,
} from './type/billing.types';

/**
 * Subscriptions (build plan §20). Two consumer tiers, Free and Premium, held in
 * the `plans` table so copy and pricing change with a row update instead of
 * three deploys.
 *
 * THERE IS NO PAYMENT GATEWAY YET, and that shapes every rule here:
 * - Selecting a paid plan records interest as PENDING. It NEVER returns ACTIVE —
 *   an ACTIVE paid subscription would hand out entitlements nobody paid for.
 * - `paymentAvailable` is always false, so clients render "Pay now" as inert.
 * - Nobody is charged and no processor is contacted anywhere in this file.
 *
 * A user has at most ONE subscription row (UNIQUE on user_id). Having no row is
 * the normal state and resolves to the free plan — we never backfill rows, and
 * reads never 404.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  /** Base URL of the web app that hosts the account area (no trailing slash). */
  private readonly webBaseUrl: string;

  /** Flipped on only when a real payment gateway is wired up. */
  private readonly paymentAvailable = false;

  private readonly catalogMissingMessage =
    "Subscription plans aren't set up on the server yet. Please try again shortly — we've been alerted.";

  constructor(
    private readonly prisma: PrismaService,
    private readonly handoffTokens: HandoffTokenService,
    config: ConfigService,
  ) {
    // Same resolution order as the password-reset link (MailService): the web
    // app first, then the API host, then a dev fallback. Never a hardcoded domain.
    const configured =
      config.get<string>('WEB_APP_URL') ?? config.get<string>('API_BASE_URL');
    if (!config.get<string>('WEB_APP_URL')) {
      // One clear warning at boot rather than a broken link per request.
      this.logger.warn(
        'WEB_APP_URL is not set — account hand-off links will point at API_BASE_URL (or localhost). Set WEB_APP_URL to the website origin.',
      );
    }
    const port = config.get<string | number>('PORT') ?? 3000;
    this.webBaseUrl = (configured ?? `http://localhost:${port}`).replace(
      /\/+$/,
      '',
    );
  }

  /**
   * The public plan catalog, display order first. Signed-out visitors hit this
   * for the website pricing page, so it must never depend on a session.
   */
  async getPlans(): Promise<PlanCatalogResult> {
    const plans = await this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
    if (plans.length === 0) {
      // An empty catalog means the seed never ran — say so loudly instead of
      // returning an empty pricing page that looks like a product decision.
      this.logger.error(
        'No active plans found in the catalog — has the subscription_plans migration/seed been applied?',
      );
      throw new ServiceUnavailableException(this.catalogMissingMessage);
    }
    return { plans: plans.map((plan) => this.toPlanView(plan)) };
  }

  /**
   * The caller's plan state. A user with no subscription row resolves to the
   * free plan with status FREE — never a 404.
   */
  async getSubscription(userId: string): Promise<SubscriptionView> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    });
    if (!subscription) {
      return this.toSubscriptionView(await this.requirePlan(FREE_PLAN_CODE), {
        status: SubscriptionStatus.FREE,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      });
    }
    return this.toSubscriptionView(subscription.plan, subscription);
  }

  /**
   * Records the plan the user picked on the web account page.
   *
   * Free is effective immediately (it is the default and costs nothing). A paid
   * plan becomes PENDING and nothing else: no charge, no gateway call, no
   * entitlements. The returned `message` tells the user, in plain words, that
   * payments aren't live yet.
   */
  async selectPlan(
    userId: string,
    planCode: string,
  ): Promise<SelectPlanResult> {
    const code = planCode.trim().toLowerCase();
    const plan = await this.prisma.plan.findFirst({
      where: { code, isActive: true },
    });
    if (!plan) {
      const available = await this.prisma.plan.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        select: { code: true },
      });
      throw new BadRequestException(
        available.length > 0
          ? `We don't have a plan called "${code}". Choose one of: ${available
              .map((row) => row.code)
              .join(', ')}.`
          : `We don't have a plan called "${code}", and no plans are currently on offer.`,
      );
    }

    // Price, not the code, decides whether money is owed — so a promo that
    // zeroes a paid plan can never leave someone stuck in PENDING.
    const costsMoney = plan.priceAmountMinor > 0;
    const now = new Date();
    const data = {
      planId: plan.id,
      // INVARIANT: a paid plan can only ever be PENDING here. ACTIVE is
      // reserved for a payment gateway confirming a real payment.
      status: costsMoney ? SubscriptionStatus.PENDING : SubscriptionStatus.FREE,
      // Free is effective now; a pending paid plan has no period at all.
      currentPeriodStart: costsMoney ? null : now,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    };

    const subscription = await this.upsertSubscription(userId, data);

    return {
      ...this.toSubscriptionView(plan, subscription),
      message: costsMoney
        ? PAYMENTS_UNAVAILABLE_MESSAGE
        : FREE_PLAN_SELECTED_MESSAGE,
    };
  }

  /**
   * Mints the one-shot URL the app opens in a browser so the signed-in user
   * lands in the web account area already signed in (the Spotify pattern — the
   * app itself sells nothing).
   *
   * The URL carries a short-lived, single-use hand-off token, never the app's own
   * access or refresh token. Treat the returned URL as a secret: do not log it.
   */
  async createPortalLink(userId: string): Promise<PortalLinkResult> {
    const { token, expiresAt } = await this.handoffTokens.issue(userId);
    const url = `${this.webBaseUrl}${WEB_ACCOUNT_PATH}?${HANDOFF_QUERY_PARAM}=${encodeURIComponent(token)}`;
    return { url, expiresAt };
  }

  /**
   * "Is this user premium?" — the accessor other modules inject when they need
   * to gate a feature. Nothing is gated on it yet (that is a separate change);
   * the single source of truth for the rule itself is `isPremiumEntitled`.
   */
  async isPremium(userId: string): Promise<boolean> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { userId },
      select: { status: true, plan: { select: { code: true } } },
    });
    return isPremiumEntitled(
      subscription
        ? { planCode: subscription.plan.code, status: subscription.status }
        : null,
    );
  }

  /**
   * One row per user, enforced by the UNIQUE on user_id. The P2002 branch covers
   * two first-time selections racing: the loser's INSERT is rejected by the
   * database, and it simply updates the row the winner created.
   */
  private async upsertSubscription(
    userId: string,
    data: {
      planId: string;
      status: SubscriptionStatus;
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
      cancelAtPeriodEnd: boolean;
    },
  ): Promise<Subscription> {
    try {
      return await this.prisma.subscription.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });
    } catch (error) {
      if (this.isPrismaError(error, 'P2002')) {
        return this.prisma.subscription.update({ where: { userId }, data });
      }
      if (this.isPrismaError(error, 'P2003')) {
        // The user row vanished between authenticating and writing.
        throw new UnauthorizedException(
          'This account no longer exists — please sign in again.',
        );
      }
      throw error;
    }
  }

  /**
   * Looks up a plan that MUST exist (the free plan backs the read model for
   * every user without a row). `isActive` is ignored on purpose: deactivating
   * the free plan must not break existing users' reads.
   */
  private async requirePlan(code: string): Promise<Plan> {
    const plan = await this.prisma.plan.findUnique({ where: { code } });
    if (!plan) {
      this.logger.error(
        `Plan "${code}" is missing from the catalog — has the subscription_plans migration/seed been applied?`,
      );
      throw new ServiceUnavailableException(this.catalogMissingMessage);
    }
    return plan;
  }

  private toPlanView(plan: Plan): PlanView {
    return {
      code: plan.code,
      name: plan.name,
      description: plan.description,
      priceAmountMinor: plan.priceAmountMinor,
      currency: plan.currency,
      interval: plan.interval,
      priceFormatted: this.formatPrice(plan.priceAmountMinor, plan.currency),
      features: plan.features,
      sortOrder: plan.sortOrder,
    };
  }

  private toSubscriptionView(
    plan: Plan,
    subscription: Pick<
      Subscription,
      'status' | 'currentPeriodEnd' | 'cancelAtPeriodEnd'
    >,
  ): SubscriptionView {
    return {
      plan: this.toPlanView(plan),
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      isPremium: isPremiumEntitled({
        planCode: plan.code,
        status: subscription.status,
      }),
      paymentAvailable: this.paymentAvailable,
    };
  }

  /**
   * Formats a minor-unit price once, server-side, so the app and the website can
   * never render the same plan differently. Assumes a 2-decimal currency (every
   * currency we price in is); a bad ISO code degrades to a plain string rather
   * than breaking the pricing page.
   */
  private formatPrice(priceAmountMinor: number, currency: string): string {
    if (priceAmountMinor <= 0) return 'Free';
    const major = priceAmountMinor / 100;
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
      }).format(major);
    } catch {
      this.logger.warn(
        `Plan price could not be formatted for currency "${currency}" — falling back to a plain amount.`,
      );
      return `${major.toFixed(2)} ${currency}`;
    }
  }

  private isPrismaError(error: unknown, code: string): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === code
    );
  }
}
