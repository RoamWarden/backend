import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DIRECTIONS_CACHE_TTL_S } from '../../common/constants';
import { keyDirectionsCache } from '../redis/constant/redis.constants';
import { RedisService } from '../redis/redis.service';
import {
  DIRECTIONS_API_URL,
  GOOGLE_TRAVEL_MODE,
} from './constant/directions.constants';
import type {
  DirectionsRoute,
  GetRouteParams,
  GoogleDirectionsResponse,
  LatLng,
} from './type/directions.types';

/**
 * Decodes a Google encoded polyline (standard algorithm, precision 1e-5).
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let byte = 0;
    let shift = 0;
    let result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/**
 * Thin wrapper around the Google Directions API. Best-effort by design: every
 * failure path logs and resolves to null so trip creation can fall back to a
 * straight-line corridor — this service NEVER throws.
 */
@Injectable()
export class DirectionsService {
  private readonly logger = new Logger(DirectionsService.name);
  private readonly apiKey: string | undefined;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.apiKey = config.get<string>('GOOGLE_MAPS_SERVER_API_KEY');
    if (!this.apiKey) {
      this.logger.warn(
        'Directions disabled — GOOGLE_MAPS_SERVER_API_KEY not set; trip corridors will use straight lines',
      );
    }
  }

  /**
   * Fetches the route between two points, Redis-cached for
   * DIRECTIONS_CACHE_TTL_S. Returns null when directions are disabled or the
   * API call fails for any reason (caller falls back to a straight line).
   */
  async getRoute(params: GetRouteParams): Promise<DirectionsRoute | null> {
    if (!this.apiKey) return null;

    const cacheKey = keyDirectionsCache(this.hashRequest(params));
    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    try {
      const url = new URL(DIRECTIONS_API_URL);
      url.searchParams.set(
        'origin',
        `${params.origin.lat},${params.origin.lng}`,
      );
      url.searchParams.set(
        'destination',
        `${params.destination.lat},${params.destination.lng}`,
      );
      url.searchParams.set('mode', GOOGLE_TRAVEL_MODE[params.mode]);
      url.searchParams.set('key', this.apiKey);

      const response = await fetch(url);
      if (!response.ok) {
        this.logger.warn(
          `Directions API returned HTTP ${response.status}; falling back to straight line`,
        );
        return null;
      }

      const body = (await response.json()) as GoogleDirectionsResponse;
      const route = body.routes?.[0];
      if (body.status !== 'OK' || !route) {
        this.logger.warn(
          `Directions API status "${body.status ?? 'unknown'}"${
            body.error_message ? ` (${body.error_message})` : ''
          }; falling back to straight line`,
        );
        return null;
      }

      const points = decodePolyline(route.overview_polyline?.points ?? '');
      if (points.length < 2) {
        this.logger.warn(
          'Directions API returned an unusable polyline (<2 points); falling back to straight line',
        );
        return null;
      }

      const legs = route.legs ?? [];
      const result: DirectionsRoute = {
        points,
        durationS: legs.reduce(
          (sum, leg) => sum + (leg.duration?.value ?? 0),
          0,
        ),
        distanceM: legs.reduce(
          (sum, leg) => sum + (leg.distance?.value ?? 0),
          0,
        ),
      };

      await this.writeCache(cacheKey, result);
      return result;
    } catch (err) {
      this.logger.warn(
        `Directions request failed (${err instanceof Error ? err.message : String(err)}); falling back to straight line`,
      );
      return null;
    }
  }

  /** sha256 of 'lat,lng|lat,lng|mode' with coordinates rounded to 5dp. */
  private hashRequest({ origin, destination, mode }: GetRouteParams): string {
    const r = (n: number): string => n.toFixed(5);
    return createHash('sha256')
      .update(
        `${r(origin.lat)},${r(origin.lng)}|${r(destination.lat)},${r(destination.lng)}|${mode}`,
      )
      .digest('hex');
  }

  private async readCache(key: string): Promise<DirectionsRoute | null> {
    try {
      const raw = await this.redis.client.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as DirectionsRoute;
    } catch (err) {
      this.logger.warn(
        `Directions cache read failed for ${key} (${err instanceof Error ? err.message : String(err)}); fetching fresh`,
      );
      return null;
    }
  }

  private async writeCache(key: string, route: DirectionsRoute): Promise<void> {
    try {
      await this.redis.client.set(
        key,
        JSON.stringify(route),
        'EX',
        DIRECTIONS_CACHE_TTL_S,
      );
    } catch (err) {
      this.logger.warn(
        `Directions cache write failed for ${key} (${err instanceof Error ? err.message : String(err)}); continuing without cache`,
      );
    }
  }
}
