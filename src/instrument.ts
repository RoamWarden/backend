import * as Sentry from '@sentry/nestjs';

// Must be imported before any other module (see main.ts). No DSN → no-op with
// a console warning so error tracking is never silently absent in production.
const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  });
} else if (process.env.NODE_ENV === 'production') {
  console.warn(
    'SENTRY_DSN is not set — error tracking is DISABLED in production.',
  );
}
