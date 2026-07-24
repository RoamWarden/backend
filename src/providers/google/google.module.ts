import { Module } from '@nestjs/common';
import { DirectionsService } from './directions.service';
import { PlacesService } from './places.service';

/**
 * Google Maps integrations: the Directions API wrapper used to build trip
 * corridors, and the Places API wrapper behind the map location picker.
 * PrismaModule/RedisModule are global, so nothing else needs importing here.
 */
@Module({
  providers: [DirectionsService, PlacesService],
  exports: [DirectionsService, PlacesService],
})
export class GoogleModule {}
