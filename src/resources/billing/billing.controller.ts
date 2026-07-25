import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { BillingService } from './billing.service';
import { SelectPlanDto } from './dto/select-plan.dto';
import type {
  EntitlementsView,
  PlanCatalogResult,
  PortalLinkResult,
  SelectPlanResult,
  SubscriptionView,
} from './type/billing.types';

/**
 * Subscription endpoints (build plan §20). Plan selection lives on the WEB
 * account area — the mobile app only reads state and opens `portal-link`.
 * No endpoint here charges anyone: there is no payment gateway yet.
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  /** Public catalog — the website pricing page must render signed-out. */
  @Public()
  @Get('plans')
  getPlans(): Promise<PlanCatalogResult> {
    return this.billingService.getPlans();
  }

  /** The caller's plan state. Users with no row resolve to Free, never a 404. */
  @Get('subscription')
  getSubscription(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SubscriptionView> {
    return this.billingService.getSubscription(user.id);
  }

  /**
   * The caller's limits and capabilities on their own — the cheap read for a
   * client that only needs to know what to SHOW. Identical shape to the
   * `entitlements` object inside GET /billing/subscription.
   *
   * `enforced` is false while ENFORCE_PLAN_LIMITS is off (the shipping state):
   * clients must then treat every number as information, never as a lock.
   */
  @Get('entitlements')
  getEntitlements(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EntitlementsView> {
    return this.billingService.getEntitlements(user.id);
  }

  /**
   * Records a plan choice. Free is effective now; a paid plan becomes PENDING
   * with `paymentAvailable: false` — nothing is charged and no entitlement is
   * granted, because checkout does not exist yet.
   */
  @Post('subscription')
  @HttpCode(HttpStatus.OK)
  selectPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SelectPlanDto,
  ): Promise<SelectPlanResult> {
    return this.billingService.selectPlan(user.id, dto.planCode);
  }

  /**
   * Mints the single-use URL the app opens in a browser to land the user, already
   * signed in, on the web account page. Throttled: each call mints a session-
   * bearing token, so a compromised client can't farm them.
   */
  @Throttle({ default: { limit: 10, ttl: 900000 } })
  @Post('portal-link')
  @HttpCode(HttpStatus.CREATED)
  createPortalLink(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PortalLinkResult> {
    return this.billingService.createPortalLink(user.id);
  }
}
