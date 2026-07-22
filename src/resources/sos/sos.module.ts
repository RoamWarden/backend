import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notification/notifications.module';
import { TripsModule } from '../trip/trips.module';
import { UsersModule } from '../user/users.module';
import { SosController } from './sos.controller';
import { SosService } from './sos.service';

/**
 * SOS raise/resolve (docs/CONTRACT.md — SosModule). Depends on trips (active
 * trip + status flip), users (trusted contacts), notifications (FCM push) and
 * auth (trip share tokens for the live-view link sent to contacts).
 * PrismaModule and RedisModule are global, so no imports are needed for them.
 */
@Module({
  imports: [UsersModule, TripsModule, NotificationsModule, AuthModule],
  controllers: [SosController],
  providers: [SosService],
})
export class SosModule {}
