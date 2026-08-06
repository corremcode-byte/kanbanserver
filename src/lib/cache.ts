import Redis from 'ioredis';
import { logger } from '../utils/logger';

/**
 * Generic response cache used to avoid recomputing expensive read endpoints
 * (analytics aggregation, etc.) on every request. Uses Redis when REDIS_URL
 * is configured (shared across instances); otherwise falls back to an
 * in-process Map. This app currently runs single-instance with no
 * REDIS_URL set, so the in-memory path is what actually runs in production
 * today — it still eliminates repeat computation within a warm instance,
 * just without surviving a restart or being shared across instances.
 *
 * Cache-backend failures never propagate to the caller: any Redis error is
 * logged and treated as a cache miss, falling through to computing fresh.
 */

const redisUrl = process.env.REDIS_URL;
let redisClient: Redis | null = null;
let redisReady = false;

if (redisUrl) {
  redisClient = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  redisClient.on('error', (err: Error) => {
    redisReady = false;
    logger.warn('Cache Redis error (falling back to in-memory):', err.message);
  });
  redisClient.on('ready', () => {
    redisReady = true;
  });
}

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

const memoryStore = new Map<string, MemoryEntry>();

function memoryGet(key: string): string | null {
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

function memorySet(key: string, value: string, ttlSeconds: number) {
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

/**
 * Returns the cached value for `key` if present, otherwise computes it via
 * `fn`, caches it for `ttlSeconds`, and returns it.
 */
export async function getOrSetCache<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  try {
    const cached = redisClient && redisReady ? await redisClient.get(key) : memoryGet(key);
    if (cached !== null) {
      return JSON.parse(cached) as T;
    }
  } catch (err) {
    logger.warn(`Cache read failed for ${key}:`, err instanceof Error ? err.message : String(err));
  }

  const fresh = await fn();

  try {
    const serialized = JSON.stringify(fresh);
    if (redisClient && redisReady) {
      await redisClient.set(key, serialized, 'EX', ttlSeconds);
    } else {
      memorySet(key, serialized, ttlSeconds);
    }
  } catch (err) {
    logger.warn(`Cache write failed for ${key}:`, err instanceof Error ? err.message : String(err));
  }

  return fresh;
}

/** Buckets a date to day granularity (YYYY-MM-DD) for use in cache keys, so
 *  callers that compute `startDate`/`endDate` fresh from `new Date()` on
 *  every request (millisecond-precision, would otherwise never hit cache)
 *  still produce a stable, cacheable key. */
export function dayBucket(d: Date): string {
  return d.toISOString().slice(0, 10);
}
