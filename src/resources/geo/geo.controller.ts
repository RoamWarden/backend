import { Controller, Get, Query } from '@nestjs/common';
import { PlacesService } from '../../providers/google/places.service';
import { NearbyPlacesQueryDto } from './dto/nearby-places.dto';
import { SearchPlacesQueryDto } from './dto/search-places.dto';
import type { PlacesView } from './type/geo.types';

/**
 * Google Places proxy for the mobile map picker. Authenticated (global JWT
 * guard) so the server-side key is never exposed. `degraded: true` tells the
 * app the lookup was unavailable — distinct from a genuinely empty result.
 */
@Controller('geo')
export class GeoController {
  constructor(private readonly placesService: PlacesService) {}

  /** Named places at/near a tapped pin. */
  @Get('places/nearby')
  async findNearby(@Query() query: NearbyPlacesQueryDto): Promise<PlacesView> {
    const places = await this.placesService.findNearby(query.lat, query.lng);
    return { places: places ?? [], degraded: places === null };
  }

  /** Free-text search for the picker's search box (lat/lng optional bias). */
  @Get('places/search')
  async searchPlaces(
    @Query() query: SearchPlacesQueryDto,
  ): Promise<PlacesView> {
    const places = await this.placesService.searchText(
      query.q,
      query.lat,
      query.lng,
    );
    return { places: places ?? [], degraded: places === null };
  }
}
