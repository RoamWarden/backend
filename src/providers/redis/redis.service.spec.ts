import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';
import {
  KEY_GEO_PRESENCE,
  KEY_ONLINE_SOCKETS,
} from './constant/redis.constants';

// Mock ioredis so constructing RedisService never opens a socket. Each `new
// Redis(...)` yields a fresh object of jest.fn() command stubs, and we grab the
// created instances off the constructor mock to assert against them.
jest.mock('ioredis', () => {
  const makeInstance = () => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue('OK'),
    duplicate: jest.fn(),
    geoadd: jest.fn().mockResolvedValue(1),
    geopos: jest.fn().mockResolvedValue([]),
    geosearch: jest.fn().mockResolvedValue([]),
    zrem: jest.fn().mockResolvedValue(1),
    hdel: jest.fn().mockResolvedValue(1),
    hincrby: jest.fn().mockResolvedValue(1),
    hmget: jest.fn().mockResolvedValue([]),
    publish: jest.fn().mockResolvedValue(1),
  });
  const RedisMock = jest.fn().mockImplementation(() => makeInstance());
  return { __esModule: true, default: RedisMock };
});

type RedisClientMock = {
  on: jest.Mock;
  connect: jest.Mock;
  quit: jest.Mock;
  duplicate: jest.Mock;
  geoadd: jest.Mock;
  geopos: jest.Mock;
  geosearch: jest.Mock;
  zrem: jest.Mock;
  hdel: jest.Mock;
  hincrby: jest.Mock;
  hmget: jest.Mock;
  publish: jest.Mock;
};

describe('RedisService', () => {
  let service: RedisService;
  let client: RedisClientMock;
  let publisher: RedisClientMock;

  const buildService = () => {
    const getOrThrow = jest.fn().mockReturnValue('redis://localhost:6379');
    const config = { getOrThrow } as unknown as ConfigService;
    const svc = new RedisService(config);
    return { svc, getOrThrow };
  };

  beforeEach(() => {
    const { svc } = buildService();
    service = svc;
    // The two `new Redis()` calls in the constructor produced distinct instances.
    client = service.client as unknown as RedisClientMock;
    publisher = service.publisher as unknown as RedisClientMock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('construction', () => {
    it('reads REDIS_URL via getOrThrow and builds two independent connections', () => {
      const { svc, getOrThrow } = buildService();
      expect(getOrThrow).toHaveBeenCalledWith('REDIS_URL');
      expect(svc.client).toBeDefined();
      expect(svc.publisher).toBeDefined();
      expect(svc.client).not.toBe(svc.publisher);
    });
  });

  describe('lifecycle', () => {
    it('onModuleInit connects both client and publisher', async () => {
      await service.onModuleInit();
      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(publisher.connect).toHaveBeenCalledTimes(1);
    });

    it('onModuleDestroy quits client, publisher, and owned subscribers', async () => {
      const sub: Partial<RedisClientMock> = {
        on: jest.fn(),
        quit: jest.fn().mockResolvedValue('OK'),
      };
      client.duplicate.mockReturnValueOnce(sub);
      service.createSubscriber();

      await service.onModuleDestroy();

      expect(client.quit).toHaveBeenCalledTimes(1);
      expect(publisher.quit).toHaveBeenCalledTimes(1);
      expect(sub.quit).toHaveBeenCalledTimes(1);
    });
  });

  describe('createSubscriber', () => {
    it('duplicates the command client and tracks it for shutdown', () => {
      const sub: Partial<RedisClientMock> = {
        on: jest.fn(),
        quit: jest.fn().mockResolvedValue('OK'),
      };
      client.duplicate.mockReturnValueOnce(sub);

      const result = service.createSubscriber();

      expect(client.duplicate).toHaveBeenCalledTimes(1);
      expect(result).toBe(sub);
    });
  });

  describe('updatePresence', () => {
    it('geoadds with args in (key, LNG, LAT, userId) order — lng before lat', async () => {
      await service.updatePresence('user-1', 6.5244, 3.3792);
      // signature is (userId, lat, lng): lat=6.5244, lng=3.3792.
      expect(client.geoadd).toHaveBeenCalledTimes(1);
      expect(client.geoadd).toHaveBeenCalledWith(
        KEY_GEO_PRESENCE,
        3.3792, // lng
        6.5244, // lat
        'user-1',
      );
      // Positional proof that lng precedes lat regardless of values.
      const geoaddArgs = client.geoadd.mock.calls[0] as unknown[];
      expect(geoaddArgs[1]).toBe(3.3792); // lng
      expect(geoaddArgs[2]).toBe(6.5244); // lat
    });
  });

  describe('getPresence', () => {
    it('maps geopos [lng, lat] tuple → { lat, lng }', async () => {
      client.geopos.mockResolvedValueOnce([['3.3792', '6.5244']]);
      const pos = await service.getPresence('user-1');
      expect(client.geopos).toHaveBeenCalledWith(KEY_GEO_PRESENCE, 'user-1');
      expect(pos).toEqual({ lng: 3.3792, lat: 6.5244 });
    });

    it('returns null when the member is absent (geopos yields [null])', async () => {
      client.geopos.mockResolvedValueOnce([null]);
      const pos = await service.getPresence('ghost');
      expect(pos).toBeNull();
    });

    it('returns null when geopos returns an empty array', async () => {
      client.geopos.mockResolvedValueOnce([]);
      const pos = await service.getPresence('ghost');
      expect(pos).toBeNull();
    });

    it('returns null when geopos returns null/undefined', async () => {
      client.geopos.mockResolvedValueOnce(null);
      const pos = await service.getPresence('ghost');
      expect(pos).toBeNull();
    });
  });

  describe('searchNearbyUserIds', () => {
    it('calls geosearch FROMLONLAT with lng then lat, BYRADIUS radius "m", ASC', async () => {
      client.geosearch.mockResolvedValueOnce(['a', 'b']);
      const ids = await service.searchNearbyUserIds(6.5244, 3.3792, 500);
      // signature is (lat, lng, radiusM): lat=6.5244, lng=3.3792, radius=500.
      expect(client.geosearch).toHaveBeenCalledWith(
        KEY_GEO_PRESENCE,
        'FROMLONLAT',
        3.3792, // lng
        6.5244, // lat
        'BYRADIUS',
        500,
        'm',
        'ASC',
      );
      const args = client.geosearch.mock.calls[0] as unknown[];
      expect(args[2]).toBe(3.3792); // lng directly follows FROMLONLAT
      expect(args[3]).toBe(6.5244); // then lat
      expect(ids).toEqual(['a', 'b']);
    });
  });

  describe('clearPresence', () => {
    it('zrems from the geo set AND hdels from the online hash', async () => {
      await service.clearPresence('user-1');
      expect(client.zrem).toHaveBeenCalledWith(KEY_GEO_PRESENCE, 'user-1');
      expect(client.hdel).toHaveBeenCalledWith(KEY_ONLINE_SOCKETS, 'user-1');
      expect(client.zrem).toHaveBeenCalledTimes(1);
      expect(client.hdel).toHaveBeenCalledTimes(1);
    });
  });

  describe('markSocketConnected', () => {
    it('hincrby +1 and returns the new socket count', async () => {
      client.hincrby.mockResolvedValueOnce(2);
      const count = await service.markSocketConnected('user-1');
      expect(client.hincrby).toHaveBeenCalledWith(
        KEY_ONLINE_SOCKETS,
        'user-1',
        1,
      );
      expect(count).toBe(2);
    });
  });

  describe('markSocketDisconnected', () => {
    it('hincrby -1 and returns the remaining count when still positive', async () => {
      client.hincrby.mockResolvedValueOnce(1);
      const remaining = await service.markSocketDisconnected('user-1');
      expect(client.hincrby).toHaveBeenCalledWith(
        KEY_ONLINE_SOCKETS,
        'user-1',
        -1,
      );
      expect(remaining).toBe(1);
      expect(client.hdel).not.toHaveBeenCalled();
    });

    it('hdels the field and returns 0 when the decremented count reaches 0', async () => {
      client.hincrby.mockResolvedValueOnce(0);
      const remaining = await service.markSocketDisconnected('user-1');
      expect(client.hdel).toHaveBeenCalledWith(KEY_ONLINE_SOCKETS, 'user-1');
      expect(remaining).toBe(0);
    });

    it('hdels the field and returns 0 when the count would go negative', async () => {
      client.hincrby.mockResolvedValueOnce(-3);
      const remaining = await service.markSocketDisconnected('user-1');
      expect(client.hdel).toHaveBeenCalledWith(KEY_ONLINE_SOCKETS, 'user-1');
      expect(remaining).toBe(0);
    });
  });

  describe('partitionOnline', () => {
    it('short-circuits to {online:[],offline:[]} on empty input without touching Redis', async () => {
      const result = await service.partitionOnline([]);
      expect(result).toEqual({ online: [], offline: [] });
      expect(client.hmget).not.toHaveBeenCalled();
    });

    it('splits into online (count>0) vs offline using an hmget lookup', async () => {
      // counts align positionally with userIds.
      client.hmget.mockResolvedValueOnce(['2', '0', null]);
      const result = await service.partitionOnline(['a', 'b', 'c']);
      expect(client.hmget).toHaveBeenCalledWith(
        KEY_ONLINE_SOCKETS,
        'a',
        'b',
        'c',
      );
      expect(result).toEqual({ online: ['a'], offline: ['b', 'c'] });
    });

    it('treats a missing hash field (null count) as offline', async () => {
      client.hmget.mockResolvedValueOnce([null]);
      const result = await service.partitionOnline(['lonely']);
      expect(result).toEqual({ online: [], offline: ['lonely'] });
    });
  });

  describe('publishJson', () => {
    it('JSON-stringifies the payload onto the publisher (not the client)', async () => {
      const payload = { type: 'ALERT', userIds: ['a', 'b'], n: 3 };
      await service.publishJson('alerts:incident', payload);
      expect(publisher.publish).toHaveBeenCalledWith(
        'alerts:incident',
        JSON.stringify(payload),
      );
      expect(client.publish).not.toHaveBeenCalled();
    });
  });
});
