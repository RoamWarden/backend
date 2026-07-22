import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  KEY_GEO_PRESENCE,
  KEY_ONLINE_SOCKETS,
} from './constant/redis.constants';

/**
 * Owns the shared Redis connections: `client` for commands, `publisher` for
 * pub/sub publishing. Subscribers block their connection, so consumers that
 * subscribe (the realtime gateway) create their own via createSubscriber()
 * and are responsible for quitting it.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  readonly publisher: Redis;
  private readonly ownedSubscribers: Redis[] = [];

  constructor(config: ConfigService) {
    const url = config.getOrThrow<string>('REDIS_URL');
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    this.publisher = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    await this.publisher.connect();
    this.logger.log('Connected to Redis');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.client.quit(),
      this.publisher.quit(),
      ...this.ownedSubscribers.map((s) => s.quit()),
    ]);
  }

  /** New dedicated connection for subscribing. Auto-closed on shutdown. */
  createSubscriber(): Redis {
    const sub = this.client.duplicate();
    this.ownedSubscribers.push(sub);
    return sub;
  }

  // ── presence ──────────────────────────────────────────────────────────

  /** Records a user's last known position (updated on every location batch). */
  async updatePresence(
    userId: string,
    lat: number,
    lng: number,
  ): Promise<void> {
    await this.client.geoadd(KEY_GEO_PRESENCE, lng, lat, userId);
  }

  /** Last known position, or null if the user has never reported one. */
  async getPresence(
    userId: string,
  ): Promise<{ lat: number; lng: number } | null> {
    const pos = await this.client.geopos(KEY_GEO_PRESENCE, userId);
    const first = pos?.[0];
    if (!first) return null;
    return { lng: Number(first[0]), lat: Number(first[1]) };
  }

  /**
   * Removes a user's last known position and online state. Called on trip
   * completion (position is only meaningful during a live trip) and on account
   * deletion (GDPR erasure — precise coordinates must not linger in Redis).
   */
  async clearPresence(userId: string): Promise<void> {
    await Promise.all([
      this.client.zrem(KEY_GEO_PRESENCE, userId),
      this.client.hdel(KEY_ONLINE_SOCKETS, userId),
    ]);
  }

  /** userIds whose last known position is within radiusM of the point. */
  async searchNearbyUserIds(
    lat: number,
    lng: number,
    radiusM: number,
  ): Promise<string[]> {
    const members = await this.client.geosearch(
      KEY_GEO_PRESENCE,
      'FROMLONLAT',
      lng,
      lat,
      'BYRADIUS',
      radiusM,
      'm',
      'ASC',
    );
    return members as string[];
  }

  // ── online tracking (multi-socket safe) ───────────────────────────────

  /** Returns the new socket count for the user. */
  async markSocketConnected(userId: string): Promise<number> {
    return this.client.hincrby(KEY_ONLINE_SOCKETS, userId, 1);
  }

  /** Returns the remaining socket count (0 = now offline). */
  async markSocketDisconnected(userId: string): Promise<number> {
    const remaining = await this.client.hincrby(KEY_ONLINE_SOCKETS, userId, -1);
    if (remaining <= 0) {
      await this.client.hdel(KEY_ONLINE_SOCKETS, userId);
      return 0;
    }
    return remaining;
  }

  /** Split a user set into online (≥1 live socket) and offline. */
  async partitionOnline(
    userIds: string[],
  ): Promise<{ online: string[]; offline: string[] }> {
    if (userIds.length === 0) return { online: [], offline: [] };
    const counts = await this.client.hmget(KEY_ONLINE_SOCKETS, ...userIds);
    const online: string[] = [];
    const offline: string[] = [];
    userIds.forEach((id, i) => {
      if (Number(counts[i] ?? 0) > 0) online.push(id);
      else offline.push(id);
    });
    return { online, offline };
  }

  /** Publish a JSON payload on a channel. */
  async publishJson(channel: string, payload: unknown): Promise<void> {
    await this.publisher.publish(channel, JSON.stringify(payload));
  }
}
