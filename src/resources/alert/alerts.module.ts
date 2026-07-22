import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notification/notifications.module';
import { AlertsService } from './alerts.service';

/**
 * Corridor matching engine + alert fan-out (docs/CONTRACT.md — AlertsModule).
 * PrismaService and RedisService come from their global modules; Notifications
 * is imported for the FCM leg. Exports AlertsService for ReportsModule.
 */
@Module({
  imports: [NotificationsModule],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
