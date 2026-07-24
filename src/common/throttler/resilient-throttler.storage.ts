import { Logger } from '@nestjs/common';
import {
  ThrottlerStorageService,
  type ThrottlerStorage,
} from '@nestjs/throttler';

/** The record shape `ThrottlerStorage.increment` resolves to (not re-exported from the root). */
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;
import { ThrottlerStorageRedisService } from 'nestjs-throttler-storage-redis';
import { RedisService } from '../../providers/redis/redis.service';

/**
 * Throttler storage backed by Redis so rate limits are shared across instances
 * and survive restarts (in-memory limits multiply per-process and reset on
 * deploy). The ThrottlerGuard runs on EVERY request, so a Redis blip must not
 * take the app down: if Redis is unreachable we fall back to per-instance
 * in-memory limiting (fail-safe, still rate-limited) instead of throwing —
 * consistent with the app's "stay up when a dependency is down" posture.
 *
 * The in-memory fallback only arms its timers when its increment() is actually
 * called (i.e. during a Redis outage); while Redis is healthy it sits idle.
 */
export class ResilientThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(ResilientThrottlerStorage.name);
  private readonly redis: ThrottlerStorageRedisService;
  private readonly memory = new ThrottlerStorageService();
  private lastFallbackLogAt = 0;

  constructor(redisService: RedisService) {
    // Reuse the app's existing error-guarded, auto-reconnecting ioredis client
    // (passing an instance, not a URL, so this never quits it on shutdown).
    this.redis = new ThrottlerStorageRedisService(redisService.client);
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      return await this.redis.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    } catch (error) {
      const now = Date.now();
      if (now - this.lastFallbackLogAt > 30_000) {
        this.lastFallbackLogAt = now;
        this.logger.warn(
          `Throttler Redis storage unavailable — falling back to per-instance in-memory limiting: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return this.memory.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }
  }
}
