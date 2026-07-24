import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { keyPlacesCache } from '../redis/constant/redis.constants';
import { RedisService } from '../redis/redis.service';
import {
  PLACES_CACHE_TTL_S,
  PLACES_MAX_RESULTS,
  PLACES_NEARBY_RADIUS_M,
  PLACES_TEXT_SEARCH_RADIUS_M,
} from './constant/places.constants';
import { PlacesService } from './places.service';
import type { Place } from './type/places.types';

interface RawResult {
  place_id?: string;
  name?: string;
  vicinity?: string;
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
  types?: string[];
}

const rawResult = (
  n: number,
  overrides: Partial<RawResult> = {},
): RawResult => ({
  place_id: `place-${n}`,
  name: `Place ${n}`,
  vicinity: `${n} Marina Road, Lagos`,
  geometry: {
    location: {
      lat: Number((6.45 + n / 1000).toFixed(3)),
      lng: Number((3.4 + n / 1000).toFixed(3)),
    },
  },
  types: ['point_of_interest', 'establishment'],
  ...overrides,
});

const okBody = (results: RawResult[] = [rawResult(1)]) => ({
  status: 'OK',
  results,
});

const okResponse = (body: unknown = okBody()) =>
  ({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body),
  }) as unknown as Response;

type GetFn = (key: string) => Promise<string | null>;
type SetFn = (
  key: string,
  value: string,
  ex: string,
  ttl: number,
) => Promise<string>;
type FetchFn = (input: URL | string) => Promise<Response>;

type RedisMock = {
  client: {
    get: jest.MockedFunction<GetFn>;
    set: jest.MockedFunction<SetFn>;
  };
};

describe('PlacesService', () => {
  let redisMock: RedisMock;
  let fetchMock: jest.MockedFunction<FetchFn>;
  let warnSpy: jest.SpyInstance;

  const build = async (apiKey: string | undefined): Promise<PlacesService> => {
    const configMock = {
      get: jest.fn((key: string) =>
        key === 'GOOGLE_MAPS_SERVER_API_KEY' ? apiKey : undefined,
      ),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PlacesService,
        { provide: ConfigService, useValue: configMock },
        { provide: RedisService, useValue: redisMock },
      ],
    }).compile();

    return moduleRef.get(PlacesService);
  };

  beforeEach(() => {
    redisMock = {
      client: {
        get: jest
          .fn<ReturnType<GetFn>, Parameters<GetFn>>()
          .mockResolvedValue(null),
        set: jest
          .fn<ReturnType<SetFn>, Parameters<SetFn>>()
          .mockResolvedValue('OK'),
      },
    };
    fetchMock = jest.fn<ReturnType<FetchFn>, Parameters<FetchFn>>();
    global.fetch = fetchMock as unknown as typeof fetch;
    // Silence the boot warning + failure-path warnings; assert on it explicitly.
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('unconfigured (no GOOGLE_MAPS_SERVER_API_KEY)', () => {
    it('logs exactly one warning at construction', async () => {
      await build(undefined);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Places disabled'),
      );
    });

    it('findNearby returns null and never calls fetch or redis', async () => {
      const service = await build(undefined);

      const places = await service.findNearby(6.5244, 3.3792);

      expect(places).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(redisMock.client.get).not.toHaveBeenCalled();
      expect(redisMock.client.set).not.toHaveBeenCalled();
    });

    it('searchText returns null and never calls fetch or redis', async () => {
      const service = await build(undefined);

      const places = await service.searchText('eko hotel');

      expect(places).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(redisMock.client.get).not.toHaveBeenCalled();
    });

    it('does not warn at construction when the key is present', async () => {
      await build('present');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('nearby search', () => {
    it('sends location, radius and key on the request URL', async () => {
      const service = await build('secret-key');
      fetchMock.mockResolvedValue(okResponse());

      await service.findNearby(6.5244, 3.3792);

      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.origin + url.pathname).toBe(
        'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
      );
      expect(url.searchParams.get('location')).toBe('6.5244,3.3792');
      expect(url.searchParams.get('radius')).toBe(
        String(PLACES_NEARBY_RADIUS_M),
      );
      expect(url.searchParams.get('key')).toBe('secret-key');
    });

    it('normalises results to { id, name, address, lat, lng, types }', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(
        okResponse(
          okBody([
            rawResult(1),
            rawResult(2, {
              vicinity: undefined,
              formatted_address: 'Formatted 2',
            }),
            rawResult(3, {
              vicinity: undefined,
              formatted_address: undefined,
              types: undefined,
            }),
          ]),
        ),
      );

      const places = await service.findNearby(6.5244, 3.3792);

      expect(places).toEqual([
        {
          id: 'place-1',
          name: 'Place 1',
          address: '1 Marina Road, Lagos',
          lat: 6.451,
          lng: 3.401,
          types: ['point_of_interest', 'establishment'],
        },
        {
          id: 'place-2',
          name: 'Place 2',
          address: 'Formatted 2',
          lat: 6.452,
          lng: 3.402,
          types: ['point_of_interest', 'establishment'],
        },
        {
          id: 'place-3',
          name: 'Place 3',
          address: '',
          lat: 6.453,
          lng: 3.403,
          types: [],
        },
      ]);
    });

    it('skips results missing place_id, name or coordinates', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(
        okResponse(
          okBody([
            rawResult(1, { place_id: undefined }),
            rawResult(2, { name: undefined }),
            rawResult(3, { geometry: {} }),
            rawResult(4),
          ]),
        ),
      );

      const places = await service.findNearby(6.5244, 3.3792);

      expect(places).toHaveLength(1);
      expect(places?.[0].id).toBe('place-4');
    });

    it(`caps results at ${PLACES_MAX_RESULTS}`, async () => {
      const service = await build('test-key');
      const many = Array.from({ length: PLACES_MAX_RESULTS + 8 }, (_, i) =>
        rawResult(i),
      );
      fetchMock.mockResolvedValue(okResponse(okBody(many)));

      const places = await service.findNearby(6.5244, 3.3792);

      expect(places).toHaveLength(PLACES_MAX_RESULTS);
    });

    it('returns [] (valid empty list, cached) on ZERO_RESULTS', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(
        okResponse({ status: 'ZERO_RESULTS', results: [] }),
      );

      const places = await service.findNearby(6.5244, 3.3792);

      expect(places).toEqual([]);
      expect(redisMock.client.set).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('text search', () => {
    it('sends query, bias location/radius and key on the request URL', async () => {
      const service = await build('secret-key');
      fetchMock.mockResolvedValue(okResponse());

      await service.searchText('eko hotel', 6.5244, 3.3792);

      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.origin + url.pathname).toBe(
        'https://maps.googleapis.com/maps/api/place/textsearch/json',
      );
      expect(url.searchParams.get('query')).toBe('eko hotel');
      expect(url.searchParams.get('location')).toBe('6.5244,3.3792');
      expect(url.searchParams.get('radius')).toBe(
        String(PLACES_TEXT_SEARCH_RADIUS_M),
      );
      expect(url.searchParams.get('key')).toBe('secret-key');
    });

    it('omits the bias when lat/lng are not provided', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      await service.searchText('eko hotel');

      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.searchParams.get('location')).toBeNull();
      expect(url.searchParams.get('radius')).toBeNull();
    });

    it('normalises text-search results (formatted_address, no vicinity)', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(
        okResponse(
          okBody([
            rawResult(1, {
              vicinity: undefined,
              formatted_address: 'Plot 1415 Adetokunbo Ademola St, Lagos',
            }),
          ]),
        ),
      );

      const places = await service.searchText('eko hotel', 6.5244, 3.3792);

      expect(places).toEqual([
        {
          id: 'place-1',
          name: 'Place 1',
          address: 'Plot 1415 Adetokunbo Ademola St, Lagos',
          lat: 6.451,
          lng: 3.401,
          types: ['point_of_interest', 'establishment'],
        },
      ]);
    });

    it('hashes the same cache key for query variants differing only in case/whitespace', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      await service.searchText('Eko Hotel  ', 6.5244, 3.3792);
      const firstKey = redisMock.client.get.mock.calls[0][0];

      redisMock.client.get.mockClear();
      await service.searchText('eko hotel', 6.5244, 3.3792);
      const secondKey = redisMock.client.get.mock.calls[0][0];

      expect(firstKey).toBe(secondKey);
    });
  });

  describe('caching', () => {
    it('returns the cached list without calling fetch on a cache hit', async () => {
      const cached: Place[] = [
        {
          id: 'place-1',
          name: 'Place 1',
          address: '1 Marina Road, Lagos',
          lat: 6.451,
          lng: 3.401,
          types: ['point_of_interest'],
        },
      ];
      redisMock.client.get.mockResolvedValue(JSON.stringify(cached));
      const service = await build('test-key');

      const places = await service.findNearby(6.5244, 3.3792);

      expect(places).toEqual(cached);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(redisMock.client.set).not.toHaveBeenCalled();
    });

    it('reads the cache under the hashed places key', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      await service.findNearby(6.5244, 3.3792);

      const key = redisMock.client.get.mock.calls[0][0];
      expect(key).toMatch(/^cache:places:[0-9a-f]{64}$/);
    });

    it('caches the normalised list with EX ttl on a cache miss', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      const places = await service.findNearby(6.5244, 3.3792);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(redisMock.client.set).toHaveBeenCalledTimes(1);
      const [key, payload, ex, ttl] = redisMock.client.set.mock.calls[0];
      expect(key).toBe(redisMock.client.get.mock.calls[0][0]);
      expect(JSON.parse(payload)).toEqual(places);
      expect(ex).toBe('EX');
      expect(ttl).toBe(PLACES_CACHE_TTL_S);
    });

    it('hashes nearby coords rounded to 4dp — same cell shares a key, different cells do not', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      await service.findNearby(6.52441, 3.37921);
      const firstKey = redisMock.client.get.mock.calls[0][0];

      redisMock.client.get.mockClear();
      await service.findNearby(6.524408, 3.379208); // rounds to the same 4dp cell
      const sameCellKey = redisMock.client.get.mock.calls[0][0];

      redisMock.client.get.mockClear();
      await service.findNearby(6.6, 3.4);
      const otherKey = redisMock.client.get.mock.calls[0][0];

      expect(firstKey).toMatch(
        new RegExp(
          `^${keyPlacesCache('').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ),
      );
      expect(sameCellKey).toBe(firstKey);
      expect(otherKey).not.toBe(firstKey);
    });

    it('still fetches fresh when the cache read throws (never throws)', async () => {
      redisMock.client.get.mockRejectedValue(new Error('redis down'));
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      const places = await service.findNearby(6.5244, 3.3792);

      expect(places).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('resolves the list even when the cache write throws', async () => {
      redisMock.client.set.mockRejectedValue(new Error('redis write failed'));
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      const places = await service.findNearby(6.5244, 3.3792);

      expect(places).toHaveLength(1);
    });
  });

  describe('failure paths return null and never throw', () => {
    it('returns null on a non-OK HTTP response', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        json: jest.fn(),
      } as unknown as Response);

      await expect(service.findNearby(6.5244, 3.3792)).resolves.toBeNull();
      expect(redisMock.client.set).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));
    });

    it('returns null on a non-OK Places status (e.g. REQUEST_DENIED)', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(
        okResponse({
          status: 'REQUEST_DENIED',
          error_message: 'The provided API key is invalid.',
          results: [],
        }),
      );

      await expect(service.findNearby(6.5244, 3.3792)).resolves.toBeNull();
      expect(redisMock.client.set).not.toHaveBeenCalled();
    });

    it('returns null (does not throw) when fetch rejects', async () => {
      const service = await build('test-key');
      fetchMock.mockRejectedValue(new Error('network down'));

      await expect(service.findNearby(6.5244, 3.3792)).resolves.toBeNull();
    });

    it('returns null (does not throw) when json parsing rejects', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockRejectedValue(new Error('bad json')),
      } as unknown as Response);

      await expect(service.searchText('eko hotel')).resolves.toBeNull();
    });
  });
});
