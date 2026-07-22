import { validateEnv } from './env.validation';

const SECRET = 'x'.repeat(32); // exactly 32 chars satisfies MinLength(32)

function validConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/roamwarden',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: SECRET,
    JWT_REFRESH_SECRET: SECRET,
    TRIP_SHARE_TOKEN_SECRET: SECRET,
    ...overrides,
  };
}

describe('validateEnv', () => {
  it('returns a validated object for a complete valid config', () => {
    const result = validateEnv(validConfig());
    expect(result.DATABASE_URL).toBe(
      'postgres://user:pass@localhost:5432/roamwarden',
    );
    expect(result.REDIS_URL).toBe('redis://localhost:6379');
    expect(result.JWT_ACCESS_SECRET).toBe(SECRET);
    expect(result.NODE_ENV).toBe('test');
  });

  it('does not throw when optional integration vars (Google/Firebase/Sentry) are absent', () => {
    // validConfig deliberately omits all Google/Firebase/Sentry vars
    expect(() => validateEnv(validConfig())).not.toThrow();
    const result = validateEnv(validConfig());
    expect(result.GOOGLE_WEB_CLIENT_ID).toBeUndefined();
    expect(result.FIREBASE_PROJECT_ID).toBeUndefined();
    expect(result.SENTRY_DSN).toBeUndefined();
  });

  it('accepts the optional integration vars when present', () => {
    const result = validateEnv(
      validConfig({
        GOOGLE_WEB_CLIENT_ID: 'web.apps.googleusercontent.com',
        FIREBASE_PROJECT_ID: 'roamwarden',
        SENTRY_DSN: 'https://abc@o0.ingest.sentry.io/1',
      }),
    );
    expect(result.GOOGLE_WEB_CLIENT_ID).toBe('web.apps.googleusercontent.com');
    expect(result.FIREBASE_PROJECT_ID).toBe('roamwarden');
    expect(result.SENTRY_DSN).toBe('https://abc@o0.ingest.sentry.io/1');
  });

  describe('required vars', () => {
    it('throws an actionable error naming DATABASE_URL when missing', () => {
      const config = validConfig();
      delete config.DATABASE_URL;
      expect(() => validateEnv(config)).toThrow(
        'DATABASE_URL is required (postgres://…)',
      );
    });

    it('throws an actionable error naming REDIS_URL when missing', () => {
      const config = validConfig();
      delete config.REDIS_URL;
      expect(() => validateEnv(config)).toThrow(
        'REDIS_URL is required (redis://…)',
      );
    });

    it('wraps errors with the Invalid environment configuration banner', () => {
      const config = validConfig();
      delete config.DATABASE_URL;
      expect(() => validateEnv(config)).toThrow(
        /Invalid environment configuration/,
      );
      expect(() => validateEnv(config)).toThrow(/Fix backend\/\.env/);
    });

    it('lists every offending var when several are missing', () => {
      const config = validConfig();
      delete config.DATABASE_URL;
      delete config.REDIS_URL;
      let message = '';
      try {
        validateEnv(config);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('DATABASE_URL is required');
      expect(message).toContain('REDIS_URL is required');
    });
  });

  describe('JWT secret length', () => {
    it('throws when JWT_ACCESS_SECRET is shorter than 32 chars', () => {
      expect(() =>
        validateEnv(validConfig({ JWT_ACCESS_SECRET: 'short' })),
      ).toThrow('JWT_ACCESS_SECRET must be at least 32 chars');
    });

    it('throws when JWT_REFRESH_SECRET is shorter than 32 chars', () => {
      expect(() =>
        validateEnv(validConfig({ JWT_REFRESH_SECRET: 'a'.repeat(31) })),
      ).toThrow('JWT_REFRESH_SECRET must be at least 32 chars');
    });

    it('throws when TRIP_SHARE_TOKEN_SECRET is shorter than 32 chars', () => {
      expect(() =>
        validateEnv(validConfig({ TRIP_SHARE_TOKEN_SECRET: '' })),
      ).toThrow('TRIP_SHARE_TOKEN_SECRET must be at least 32 chars');
    });

    it('accepts a secret exactly 32 chars long', () => {
      expect(() =>
        validateEnv(validConfig({ JWT_ACCESS_SECRET: 'a'.repeat(32) })),
      ).not.toThrow();
    });
  });

  describe('numeric coercion', () => {
    it('coerces PORT from a string to an integer', () => {
      const result = validateEnv(validConfig({ PORT: '8080' }));
      expect(result.PORT).toBe(8080);
      expect(typeof result.PORT).toBe('number');
    });

    it('coerces RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX from strings', () => {
      const result = validateEnv(
        validConfig({ RATE_LIMIT_WINDOW_MS: '60000', RATE_LIMIT_MAX: '120' }),
      );
      expect(result.RATE_LIMIT_WINDOW_MS).toBe(60000);
      expect(result.RATE_LIMIT_MAX).toBe(120);
    });

    it('throws when PORT is not a valid integer', () => {
      expect(() => validateEnv(validConfig({ PORT: 'not-a-number' }))).toThrow(
        /Invalid environment configuration/,
      );
    });

    it('throws when RATE_LIMIT_WINDOW_MS is below its minimum', () => {
      expect(() =>
        validateEnv(validConfig({ RATE_LIMIT_WINDOW_MS: '10' })),
      ).toThrow(/Invalid environment configuration/);
    });
  });
});
