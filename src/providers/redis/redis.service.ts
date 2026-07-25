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
  SCRIPT_CLAIM_ONCE,
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
  private lastErrorLogAt = 0;

  constructor(config: ConfigService) {
    const url = config.getOrThrow<string>('REDIS_URL');
    const options = { lazyConnect: true, maxRetriesPerRequest: 3 } as const;
    this.client = new Redis(url, options);
    this.publisher = new Redis(url, options);
    // CRITICAL: ioredis emits an 'error' event on every failed connection
    // attempt. With NO 'error' listener, Node promotes it to an *unhandled error
    // event* and ABORTS the process (SIGABRT / exit 134) — killing the app
    // before it can bind its port. Attaching a listener keeps us alive so
    // ioredis can reconnect in the background.
    this.attachErrorLogger(this.client, 'client');
    this.attachErrorLogger(this.publisher, 'publisher');
  }

  private attachErrorLogger(conn: Redis, which: string): void {
    conn.on('error', (err: Error) => {
      // Throttle reconnect-storm spam to one line per 30s.
      const now = Date.now();
      if (now - this.lastErrorLogAt > 30_000) {
        this.lastErrorLogAt = now;
        this.logger.warn(`Redis ${which} connection error: ${err.message}`);
      }
    });
  }

  async onModuleInit(): Promise<void> {
    // Connect eagerly but NEVER block or crash boot on it: the HTTP port must
    // bind even if Redis is briefly unreachable at startup. ioredis auto-
    // reconnects, and /health reports the live status.
    try {
      await Promise.all([this.client.connect(), this.publisher.connect()]);
      this.logger.log('Connected to Redis');
    } catch (err) {
      this.logger.error(
        `Redis not reachable at boot — starting anyway; it will reconnect in the background. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
    // Same crash-guard as the main connections.
    this.attachErrorLogger(sub, 'subscriber');
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

  /**
   * Fixed-window counter: increments `key`, setting a TTL of `windowS` on first
   * use, and returns the new count. Returns null if Redis is unavailable so
   * callers can fail-open (used by the per-email OTP send quota).
   */
  async incrementCounter(key: string, windowS: number): Promise<number | null> {
    try {
      const count = await this.client.incr(key);
      if (count === 1) {
        await this.client.expire(key, windowS);
      }
      return count;
    } catch (err) {
      const now = Date.now();
      if (now - this.lastErrorLogAt > 30_000) {
        this.lastErrorLogAt = now;
        this.logger.warn(
          `Redis counter increment failed for ${key}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return null;
    }
  }

  // ── single-use tokens ─────────────────────────────────────────────────

  /**
   * Stores `value` under `key` with an expiry of `ttlS` seconds.
   *
   * Unlike `incrementCounter`, this deliberately does NOT swallow Redis errors:
   * it backs security-sensitive single-use tokens, where a silent write failure
   * would mint a token that can never be redeemed. The caller must surface the
   * failure to the user.
   */
  async setWithTtl(key: string, value: string, ttlS: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlS);
  }

  /**
   * Atomically reads and deletes `key`, returning the stored value (or null if
   * it was missing, already claimed, or expired).
   *
   * The GET+DEL happens inside a single Lua script, so it is indivisible: two
   * concurrent callers can never both receive the value. That is what makes a
   * token single-use even under a double-submit or a retry storm. Errors
   * propagate — a Redis failure must fail CLOSED (no session), never fail open.
   */
  async claimOnce(key: string): Promise<string | null> {
    const value: unknown = await this.client.eval(SCRIPT_CLAIM_ONCE, 1, key);
    return typeof value === 'string' ? value : null;
  }
}
