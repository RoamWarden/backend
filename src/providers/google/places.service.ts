import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { keyPlacesCache } from '../redis/constant/redis.constants';
import { RedisService } from '../redis/redis.service';
import {
  PLACES_CACHE_TTL_S,
  PLACES_MAX_RESULTS,
  PLACES_NEARBY_API_URL,
  PLACES_NEARBY_RADIUS_M,
  PLACES_TEXT_SEARCH_API_URL,
  PLACES_TEXT_SEARCH_RADIUS_M,
} from './constant/places.constants';
import type { GooglePlacesResponse, Place } from './type/places.types';

/**
 * Thin wrapper around the Google Places API (nearby + text search) used by the
 * map location picker. Best-effort by design: every failure path logs and
 * resolves to null so the picker can degrade to raw coordinates — this service
 * NEVER throws. Callers must distinguish "nothing there" ([]) from "lookup
 * unavailable" (null).
 */
@Injectable()
export class PlacesService {
  private readonly logger = new Logger(PlacesService.name);
  private readonly apiKey: string | undefined;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.apiKey = config.get<string>('GOOGLE_MAPS_SERVER_API_KEY');
    if (!this.apiKey) {
      this.logger.warn(
        'Places disabled — GOOGLE_MAPS_SERVER_API_KEY not set; the map picker will fall back to raw coordinates',
      );
    }
  }

  /**
   * Named places within PLACES_NEARBY_RADIUS_M of a tapped coordinate,
   * Redis-cached for PLACES_CACHE_TTL_S (coords rounded to 4dp). Returns []
   * when Google genuinely finds nothing (ZERO_RESULTS) and null when the
   * lookup is unavailable (no key / HTTP error / bad status).
   */
  async findNearby(lat: number, lng: number): Promise<Place[] | null> {
    if (!this.apiKey) return null;

    const cacheKey = keyPlacesCache(this.hashNearby(lat, lng));
    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    const url = new URL(PLACES_NEARBY_API_URL);
    url.searchParams.set('location', `${lat},${lng}`);
    url.searchParams.set('radius', String(PLACES_NEARBY_RADIUS_M));
    url.searchParams.set('key', this.apiKey);

    const places = await this.fetchPlaces(url, 'Places nearby search');
    if (places) await this.writeCache(cacheKey, places);
    return places;
  }

  /**
   * Free-text place search for the picker's search box, optionally biased to a
   * coordinate (PLACES_TEXT_SEARCH_RADIUS_M). Redis-cached for
   * PLACES_CACHE_TTL_S on the normalised query + rounded bias. Same [] vs null
   * semantics as findNearby.
   */
  async searchText(
    query: string,
    lat?: number,
    lng?: number,
  ): Promise<Place[] | null> {
    if (!this.apiKey) return null;

    const cacheKey = keyPlacesCache(this.hashSearch(query, lat, lng));
    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    const url = new URL(PLACES_TEXT_SEARCH_API_URL);
    url.searchParams.set('query', query);
    if (lat !== undefined && lng !== undefined) {
      url.searchParams.set('location', `${lat},${lng}`);
      url.searchParams.set('radius', String(PLACES_TEXT_SEARCH_RADIUS_M));
    }
    url.searchParams.set('key', this.apiKey);

    const places = await this.fetchPlaces(url, 'Places text search');
    if (places) await this.writeCache(cacheKey, places);
    return places;
  }

  /**
   * Shared request + normalisation. ZERO_RESULTS is a valid empty list, NOT a
   * failure; every real failure logs a warning and resolves to null.
   */
  private async fetchPlaces(url: URL, label: string): Promise<Place[] | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        this.logger.warn(
          `${label} returned HTTP ${response.status}; place lookup degraded`,
        );
        return null;
      }

      const body = (await response.json()) as GooglePlacesResponse;
      if (body.status === 'ZERO_RESULTS') return [];
      if (body.status !== 'OK') {
        this.logger.warn(
          `${label} status "${body.status ?? 'unknown'}"${
            body.error_message ? ` (${body.error_message})` : ''
          }; place lookup degraded`,
        );
        return null;
      }

      const places: Place[] = [];
      for (const result of body.results ?? []) {
        const placeLat = result.geometry?.location?.lat;
        const placeLng = result.geometry?.location?.lng;
        if (
          !result.place_id ||
          !result.name ||
          typeof placeLat !== 'number' ||
          typeof placeLng !== 'number'
        ) {
          continue;
        }
        places.push({
          id: result.place_id,
          name: result.name,
          address: result.vicinity ?? result.formatted_address ?? '',
          lat: placeLat,
          lng: placeLng,
          types: result.types ?? [],
        });
        if (places.length >= PLACES_MAX_RESULTS) break;
      }
      return places;
    } catch (err) {
      this.logger.warn(
        `${label} request failed (${err instanceof Error ? err.message : String(err)}); place lookup degraded`,
      );
      return null;
    }
  }

  /** sha256 of 'nearby|lat,lng' with coordinates rounded to 4dp (~11 m). */
  private hashNearby(lat: number, lng: number): string {
    const r = (n: number): string => n.toFixed(4);
    return createHash('sha256')
      .update(`nearby|${r(lat)},${r(lng)}`)
      .digest('hex');
  }

  /** sha256 of 'search|query|lat,lng' — query lowercased+trimmed, bias rounded to 4dp ('' when absent). */
  private hashSearch(query: string, lat?: number, lng?: number): string {
    const r = (n: number): string => n.toFixed(4);
    const bias =
      lat !== undefined && lng !== undefined ? `${r(lat)},${r(lng)}` : '';
    return createHash('sha256')
      .update(`search|${query.toLowerCase().trim()}|${bias}`)
      .digest('hex');
  }

  private async readCache(key: string): Promise<Place[] | null> {
    try {
      const raw = await this.redis.client.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as Place[];
    } catch (err) {
      this.logger.warn(
        `Places cache read failed for ${key} (${err instanceof Error ? err.message : String(err)}); fetching fresh`,
      );
      return null;
    }
  }

  private async writeCache(key: string, places: Place[]): Promise<void> {
    try {
      await this.redis.client.set(
        key,
        JSON.stringify(places),
        'EX',
        PLACES_CACHE_TTL_S,
      );
    } catch (err) {
      this.logger.warn(
        `Places cache write failed for ${key} (${err instanceof Error ? err.message : String(err)}); continuing without cache`,
      );
    }
  }
}
