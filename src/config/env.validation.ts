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
  // Resend is the primary provider; SMTP_URL is a legacy fallback.
  @IsOptional()
  @IsString()
  RESEND_API_KEY?: string;

  @IsOptional()
  @IsString()
  SMTP_URL?: string;

  @IsOptional()
  @IsString()
  MAIL_FROM?: string;

  // Base URL of the web app that hosts the password-reset page (the reset link
  // points here with ?token=…). Falls back to API_BASE_URL.
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
