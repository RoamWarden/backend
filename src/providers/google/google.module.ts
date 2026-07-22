import { Module } from '@nestjs/common';
import { DirectionsService } from './directions.service';

/**
 * Google Maps integrations. Currently only the Directions API wrapper used to
 * build trip corridors. PrismaModule/RedisModule are global, so nothing else
 * needs importing here.
 */
@Module({
  providers: [DirectionsService],
  exports: [DirectionsService],
})
export class GoogleModule {}
