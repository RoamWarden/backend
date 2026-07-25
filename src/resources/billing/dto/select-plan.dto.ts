import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { PLAN_CODE_MAX_LENGTH } from '../constant/billing.constants';

/**
 * Body for POST /billing/subscription.
 *
 * `planCode` is intentionally NOT validated against an enum here: plans are a
 * database catalog, so the real check is a catalog lookup in BillingService
 * (an unknown code gets a 400 naming the codes that do exist). This DTO only
 * bounds the shape.
 */
export class SelectPlanDto {
  @IsString({
    message:
      "planCode must be a plan code from GET /billing/plans, e.g. 'free'.",
  })
  @IsNotEmpty({
    message: 'planCode is required — pick a plan from GET /billing/plans.',
  })
  @MaxLength(PLAN_CODE_MAX_LENGTH, {
    message: `planCode must be at most ${PLAN_CODE_MAX_LENGTH} characters.`,
  })
  planCode!: string;
}
