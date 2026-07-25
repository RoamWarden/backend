import './instrument';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';

// Never let a stray async error abort the process silently (which shows up on
// hosts like Render as an opaque "Exited with status 134"). Log and keep
// serving — the server should stay up through transient dependency blips.
process.on('unhandledRejection', (reason) => {
  new Logger('Process').error(
    `Unhandled promise rejection: ${
      reason instanceof Error ? reason.stack : String(reason)
    }`,
  );
});
process.on('uncaughtException', (err) => {
  new Logger('Process').error(
    `Uncaught exception: ${err.stack ?? err.message}`,
  );
});

async function bootstrap() {
  // Behind a proxy (Render/Fly/ALB) every request arrives from the proxy's IP,
  // which would collapse per-IP rate limiting onto a single bucket. Trust the
  // proxy's X-Forwarded-For so req.ip is the real client. Enabled in
  // production (where a known proxy fronts us) or via TRUST_PROXY; off in local
  // dev, where trusting a spoofable header would itself defeat throttling.
  const trustProxy =
    process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production';
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy }),
    // Buffer framework logs until the Pino logger is wired below, so startup
    // logs also render through Pino (pretty in dev, JSON in prod).
    { bufferLogs: true },
  );

  // Route ALL app logging (including every `new Logger(ctx)` in services)
  // through Pino. Mirrors the fantasy-pro-league backend.
  app.useLogger(app.get(PinoLogger));

  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  /**
   * Our own web app is ALWAYS allowed, derived from WEB_APP_URL.
   *
   * WEB_APP_URL is already the canonical "where our front end lives" — it is what
   * /billing/portal-link builds the app→web handoff against. Deriving the CORS
   * entry from the same variable means the two cannot drift: previously the
   * deployed site was a valid handoff target that the API then refused to talk
   * to, so every browser fetch failed preflight and the pricing page reported
   * "We couldn't reach RoamWarden" — a CORS rejection wearing a network error's
   * clothes. Only the ORIGIN is taken (scheme + host + port); a path in
   * WEB_APP_URL would never match a browser's Origin header.
   */
  const webAppOrigin = ((): string | null => {
    const raw = process.env.WEB_APP_URL?.trim();
    if (!raw) return null;
    try {
      return new URL(raw).origin;
    } catch {
      new Logger('Bootstrap').warn(
        `WEB_APP_URL is not a valid URL (${raw}) — not adding it to the CORS allow-list`,
      );
      return null;
    }
  })();

  const allowedOrigins = [
    ...new Set([...corsOrigins, ...(webAppOrigin ? [webAppOrigin] : [])]),
  ];

  app.enableCors({
    // No allow-list configured at all => reflect any origin. That is the local
    // dev default; in production either CORS_ORIGINS or WEB_APP_URL is set.
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  });
  new Logger('Bootstrap').log(
    allowedOrigins.length > 0
      ? `CORS allow-list: ${allowedOrigins.join(', ')}`
      : 'CORS: no allow-list configured — reflecting all origins (development default)',
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`RoamWarden API listening on 0.0.0.0:${port}`);
}

bootstrap().catch((err) => {
  // A boot failure (missing env, bad config) should exit with a clear message
  // and a non-zero code — never a silent abort.
  new Logger('Bootstrap').error(
    `Failed to start RoamWarden API: ${err instanceof Error ? err.stack : String(err)}`,
  );
  process.exit(1);
});
