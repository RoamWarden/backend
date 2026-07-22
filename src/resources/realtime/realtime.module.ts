import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TripsModule } from '../trip/trips.module';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Realtime delivery: the Socket.IO gateway plus the Redis subscriber bridge
 * that relays incident alerts, SOS events and per-trip live streams to the
 * sockets this instance hosts. RedisService arrives via the global RedisModule.
 */
@Module({
  imports: [AuthModule, TripsModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
