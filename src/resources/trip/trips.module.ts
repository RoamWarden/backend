import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GoogleModule } from '../../providers/google/google.module';
import { NotificationsModule } from '../notification/notifications.module';
import { UsersModule } from '../user/users.module';
import { TripMonitorService } from './trip-monitor.service';
import { TripStatsService } from './trip-stats.service';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';

// EntitlementsService (trip history retention + the `analytics` capability) needs
// no import here — EntitlementsModule is @Global.
@Module({
  imports: [AuthModule, UsersModule, NotificationsModule, GoogleModule],
  controllers: [TripsController],
  providers: [TripsService, TripMonitorService, TripStatsService],
  exports: [TripsService],
})
export class TripsModule {}
