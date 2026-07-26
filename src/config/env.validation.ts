import { plainToInstance, Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Fail-fast validation of process.env at boot. Required vars missing → the app
 * refuses to start with a clear message (never a silent misconfiguration).
 * Integration vars (Google, Firebase, Sentry) are optional: their features
 * degrade gracefully with a logged warning instead.
 */
export class EnvironmentVariables {
  @IsOptional()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  PORT?: number;

  @IsOptional()
  @IsString()
  API_BASE_URL?: string;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  @IsString({ message: 'DATABASE_URL is required (postgres://…)' })
  DATABASE_URL!: string;

  @IsString({ message: 'REDIS_URL is required (redis://…)' })
  REDIS_URL!: string;

  @IsString()
  @MinLength(32, {
    message:
      'JWT_ACCESS_SECRET must be at least 32 chars (openssl rand -base64 48)',
  })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32, {
    message:
      'JWT_REFRESH_SECRET must be at least 32 chars (openssl rand -base64 48)',
  })
  JWT_REFRESH_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_TTL?: string;

  @IsOptional()
  @IsString()
  JWT_REFRESH_TTL?: string;

  @IsString()
  @MinLength(32, {
    message:
      'TRIP_SHARE_TOKEN_SECRET must be at least 32 chars (openssl rand -base64 48)',
  })
  TRIP_SHARE_TOKEN_SECRET!: string;

  @IsOptional()
  @IsString()
  TRIP_SHARE_TOKEN_TTL?: string;

  // Google (optional — auth/maps degrade with a warning when absent)
  @IsOptional()
  @IsString()
  GOOGLE_WEB_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  GOOGLE_IOS_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  GOOGLE_ANDROID_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  GOOGLE_MAPS_SERVER_API_KEY?: string;

  // Firebase (optional — push disabled with a warning when absent)
  @IsOptional()
  @IsString()
  FIREBASE_PROJECT_ID?: string;

  @IsOptional()
  @IsString()
  FIREBASE_CLIENT_EMAIL?: string;

  @IsOptional()
  @IsString()
  FIREBASE_PRIVATE_KEY?: string;

  @IsOptional()
  @IsString()
  SENTRY_DSN?: string;

  // Email (optional — emails degrade to logged output when no provider is set).
  // Brevo is the primary provider; SMTP_URL is a legacy fallback.
  @IsOptional()
  @IsString()
  BREVO_API_KEY?: string;

  // Override the Brevo API base URL (defaults to https://api.brevo.com).
  @IsOptional()
  @IsString()
  BREVO_API_BASE_URL?: string;

  @IsOptional()
  @IsString()
  SMTP_URL?: string;

  @IsOptional()
  @IsString()
  MAIL_FROM?: string;

  // Base URL of the website. Hosts the password-reset page (the reset link points
  // here with ?token=…) and the subscription account area the app hands users off
  // to (`/account?handoff=…` — see BillingService). Falls back to API_BASE_URL.
  @IsOptional()
  @IsString()
  WEB_APP_URL?: string;

  // Trust the proxy's X-Forwarded-For for rate limiting (see main.ts).
  @IsOptional()
  @IsString()
  TRUST_PROXY?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1000)
  RATE_LIMIT_WINDOW_MS?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  RATE_LIMIT_MAX?: number;

  /**
   * MASTER SWITCH for plan-limit ENFORCEMENT (build plan §20). Unset defaults to
   * FALSE, and false is the shipping state: there is no payment gateway, so
   * nobody can hold an ACTIVE paid subscription, so enforcing Free limits would
   * only take capabilities away from users who cannot buy them back.
   *
   * While it is off, every user keeps everything they can do today — limits are
   * computed, returned to clients and logged, but never applied. Flip it to
   * 'true' only once checkout is live. Validated rather than left free-form so a
   * typo ('yes', 'TRUE ') fails at boot with a clear message instead of quietly
   * meaning something.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(['true', 'false'], {
    message:
      'ENFORCE_PLAN_LIMITS must be "true" or "false" (leave it unset or false until billing is live — true takes features away from users on the Free plan).',
  })
  ENFORCE_PLAN_LIMITS?: string;

  /**
   * MASTER SWITCH for the SOS escalation ladder (re-paging trusted contacts one
   * at a time after an unanswered SOS). Unset defaults to FALSE, and false is
   * the shipping state.
   *
   * IT STAYS OFF UNTIL A CLIENT CAN ACKNOWLEDGE AN ESCALATION. The ladder's only
   * stop conditions are the traveller resolving their SOS (POST /sos/:id/resolve)
   * and a trusted contact acknowledging it (POST /sos/:id/ack). The shipped app
   * calls neither, so an armed ladder would run every SOS to exhaustion and then
   * push the traveller "No one has answered your SOS" — something the server
   * cannot know, on the screen where a false alarm costs the most.
   *
   * Off changes nothing else about SOS: every consenting contact is still
   * alerted at once, the delivery trail is still recorded for every user, and a
   * withdrawal still stands those contacts down. Validated rather than left
   * free-form so a typo ('yes', 'TRUE ') fails at boot instead of quietly
   * meaning something.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(['true', 'false'], {
    message:
      'SOS_ESCALATION_ENABLED must be "true" or "false" (leave it unset or false until the app can resolve and acknowledge an SOS — otherwise every SOS ends by telling the traveller nobody answered).',
  })
  SOS_ESCALATION_ENABLED?: string;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });
  if (errors.length > 0) {
    const details = errors
      .map((e) => Object.values(e.constraints ?? {}).join('; '))
      .filter(Boolean)
      .join('\n  - ');
    throw new Error(
      `Invalid environment configuration:\n  - ${details}\nFix backend/.env (see example.env) and restart.`,
    );
  }
  return validated;
}
