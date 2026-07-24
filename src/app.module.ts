import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';

import { AppController } from './app.controller';
import { AlertsModule } from './resources/alert/alerts.module';
import { AuthModule } from './resources/auth/auth.module';
import { JwtAuthGuard } from './resources/auth/jwt-auth.guard';
import { validateEnv } from './config/env.validation';
import { LoggerModule } from './logger/logger.module';
import { GoogleModule } from './providers/google/google.module';
import { NotificationsModule } from './resources/notification/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './resources/realtime/realtime.module';
import { RedisModule } from './providers/redis/redis.module';
import { ReportsModule } from './resources/report/reports.module';
import { SosModule } from './resources/sos/sos.module';
import { TripsModule } from './resources/trip/trips.module';
import { UsersModule } from './resources/user/users.module';
import { WaitlistModule } from './resources/waitlist/waitlist.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: '.env',
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('RATE_LIMIT_WINDOW_MS') ?? 60000,
            limit: config.get<number>('RATE_LIMIT_MAX') ?? 100,
          },
        ],
      }),
    }),
    ScheduleModule.forRoot(),
    SentryModule.forRoot(),
    LoggerModule,
    PrismaModule,
    RedisModule,
    AuthModule,
    UsersModule,
    TripsModule,
    GoogleModule,
    ReportsModule,
    AlertsModule,
    NotificationsModule,
    RealtimeModule,
    SosModule,
    WaitlistModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
