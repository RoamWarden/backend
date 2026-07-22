import './instrument';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
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
  );

  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  });

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
