import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TransportMode } from '@prisma/client';
import { DIRECTIONS_CACHE_TTL_S } from '../../common/constants';
import { keyDirectionsCache } from '../redis/constant/redis.constants';
import { RedisService } from '../redis/redis.service';
import { DirectionsService } from './directions.service';
import type { GetRouteParams } from './type/directions.types';

// Classic Google reference polyline → known [lat,lng] pairs (precision 1e-5).
// https://developers.google.com/maps/documentation/utilities/polylinealgorithm
const REFERENCE_POLYLINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const REFERENCE_POINTS: Array<[number, number]> = [
  [38.5, -120.2],
  [40.7, -120.95],
  [43.252, -126.453],
];

const okBody = (
  points: string = REFERENCE_POLYLINE,
  legs: Array<{
    duration?: { value?: number };
    distance?: { value?: number };
  }> = [{ duration: { value: 600 }, distance: { value: 12000 } }],
) => ({
  status: 'OK',
  routes: [{ overview_polyline: { points }, legs }],
});

const okResponse = (body: unknown = okBody()) =>
  ({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body),
  }) as unknown as Response;

const params = (mode: TransportMode = TransportMode.CAR): GetRouteParams => ({
  origin: { lat: 6.5244, lng: 3.3792 },
  destination: { lat: 6.4654, lng: 3.4064 },
  mode,
});

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

describe('DirectionsService', () => {
  let redisMock: RedisMock;
  let fetchMock: jest.MockedFunction<FetchFn>;
  let warnSpy: jest.SpyInstance;

  const build = async (
    apiKey: string | undefined,
  ): Promise<DirectionsService> => {
    const configMock = {
      get: jest.fn((key: string) =>
        key === 'GOOGLE_MAPS_SERVER_API_KEY' ? apiKey : undefined,
      ),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        DirectionsService,
        { provide: ConfigService, useValue: configMock },
        { provide: RedisService, useValue: redisMock },
      ],
    }).compile();

    return moduleRef.get(DirectionsService);
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

  describe('polyline decoder (1e-5 precision)', () => {
    it('decodes the classic reference polyline to the known lat/lng pairs', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      const route = await service.getRoute(params());

      expect(route).not.toBeNull();
      expect(route?.points).toHaveLength(REFERENCE_POINTS.length);
      route?.points.forEach((point, i) => {
        expect(point.lat).toBeCloseTo(REFERENCE_POINTS[i][0], 5);
        expect(point.lng).toBeCloseTo(REFERENCE_POINTS[i][1], 5);
      });
    });

    it('sums leg duration and distance into the route', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(
        okResponse(
          okBody(REFERENCE_POLYLINE, [
            { duration: { value: 300 }, distance: { value: 5000 } },
            { duration: { value: 200 }, distance: { value: 3000 } },
          ]),
        ),
      );

      const route = await service.getRoute(params());

      expect(route?.durationS).toBe(500);
      expect(route?.distanceM).toBe(8000);
    });
  });

  describe('mode mapping (Google travel mode query param)', () => {
    const modeUrl = async (mode: TransportMode): Promise<URL> => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());
      await service.getRoute(params(mode));
      // fetch is called with a URL instance; normalise to URL for param reads.
      return new URL(String(fetchMock.mock.calls[0][0]));
    };

    it.each([
      [TransportMode.CAR, 'driving'],
      [TransportMode.MOTORBIKE, 'driving'],
      [TransportMode.OTHER, 'driving'],
      [TransportMode.BUS, 'transit'],
      [TransportMode.TRAIN, 'transit'],
      [TransportMode.WALK, 'walking'],
      [TransportMode.BICYCLE, 'bicycling'],
    ])('maps %s to mode=%s', async (mode, expected) => {
      const url = await modeUrl(mode);
      expect(url.searchParams.get('mode')).toBe(expected);
    });

    it('sends origin, destination and key on the request URL', async () => {
      const service = await build('secret-key');
      fetchMock.mockResolvedValue(okResponse());

      await service.getRoute(params(TransportMode.CAR));

      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.origin + url.pathname).toBe(
        'https://maps.googleapis.com/maps/api/directions/json',
      );
      expect(url.searchParams.get('origin')).toBe('6.5244,3.3792');
      expect(url.searchParams.get('destination')).toBe('6.4654,3.4064');
      expect(url.searchParams.get('key')).toBe('secret-key');
    });
  });

  describe('unconfigured (no GOOGLE_MAPS_SERVER_API_KEY)', () => {
    it('logs exactly one warning at construction', async () => {
      await build(undefined);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Directions disabled'),
      );
    });

    it('getRoute returns null and never calls fetch or redis', async () => {
      const service = await build(undefined);

      const route = await service.getRoute(params());

      expect(route).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(redisMock.client.get).not.toHaveBeenCalled();
      expect(redisMock.client.set).not.toHaveBeenCalled();
    });

    it('does not warn at construction when the key is present', async () => {
      await build('present');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('returns the cached route without calling fetch on a cache hit', async () => {
      const cached = {
        points: [
          { lat: 1, lng: 2 },
          { lat: 3, lng: 4 },
        ],
        durationS: 42,
        distanceM: 99,
      };
      redisMock.client.get.mockResolvedValue(JSON.stringify(cached));
      const service = await build('test-key');

      const route = await service.getRoute(params());

      expect(route).toEqual(cached);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(redisMock.client.set).not.toHaveBeenCalled();
    });

    it('reads the cache under the hashed directions key', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      await service.getRoute(params());

      const key = redisMock.client.get.mock.calls[0][0];
      expect(key).toMatch(/^cache:directions:[0-9a-f]{64}$/);
    });

    it('caches the decoded result with EX ttl on a cache miss', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      const route = await service.getRoute(params());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(redisMock.client.set).toHaveBeenCalledTimes(1);
      const [key, payload, ex, ttl] = redisMock.client.set.mock.calls[0];
      expect(key).toBe(redisMock.client.get.mock.calls[0][0]);
      expect(JSON.parse(payload)).toEqual(route);
      expect(ex).toBe('EX');
      expect(ttl).toBe(DIRECTIONS_CACHE_TTL_S);
    });

    it('the cache key equals keyDirectionsCache(sha256) for the same request', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      await service.getRoute(params(TransportMode.CAR));
      const firstKey = redisMock.client.get.mock.calls[0][0];

      // A distinct request must hash to a different cache key.
      redisMock.client.get.mockClear();
      await service.getRoute(params(TransportMode.WALK));
      const secondKey = redisMock.client.get.mock.calls[0][0];

      expect(firstKey).toMatch(
        new RegExp(
          `^${keyDirectionsCache('').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ),
      );
      expect(firstKey).not.toBe(secondKey);
    });

    it('still fetches fresh when the cache read throws (never throws)', async () => {
      redisMock.client.get.mockRejectedValue(new Error('redis down'));
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      const route = await service.getRoute(params());

      expect(route).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('resolves the route even when the cache write throws', async () => {
      redisMock.client.set.mockRejectedValue(new Error('redis write failed'));
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse());

      const route = await service.getRoute(params());

      expect(route).not.toBeNull();
      expect(route?.points).toHaveLength(REFERENCE_POINTS.length);
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

      await expect(service.getRoute(params())).resolves.toBeNull();
      expect(redisMock.client.set).not.toHaveBeenCalled();
    });

    it('returns null when body.status !== "OK"', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(
        okResponse({
          status: 'ZERO_RESULTS',
          error_message: 'no route',
          routes: [],
        }),
      );

      await expect(service.getRoute(params())).resolves.toBeNull();
      expect(redisMock.client.set).not.toHaveBeenCalled();
    });

    it('returns null when the response has no routes', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue(okResponse({ status: 'OK' }));

      await expect(service.getRoute(params())).resolves.toBeNull();
    });

    it('returns null when the decoded polyline has fewer than 2 points', async () => {
      const service = await build('test-key');
      // '_p~iF~ps|U' decodes to a single point.
      fetchMock.mockResolvedValue(okResponse(okBody('_p~iF~ps|U')));

      await expect(service.getRoute(params())).resolves.toBeNull();
      expect(redisMock.client.set).not.toHaveBeenCalled();
    });

    it('returns null (does not throw) when fetch rejects', async () => {
      const service = await build('test-key');
      fetchMock.mockRejectedValue(new Error('network down'));

      await expect(service.getRoute(params())).resolves.toBeNull();
    });

    it('returns null (does not throw) when json parsing rejects', async () => {
      const service = await build('test-key');
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockRejectedValue(new Error('bad json')),
      } as unknown as Response);

      await expect(service.getRoute(params())).resolves.toBeNull();
    });
  });
});
