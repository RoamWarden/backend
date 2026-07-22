import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

/**
 * Firebase Admin FCM wrapper (docs/CONTRACT.md — NotificationsModule).
 * Exports NotificationsService for alerts, trips, and sos to push to users'
 * devices. Degrades to a warned no-op when Firebase env vars are absent.
 */
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
