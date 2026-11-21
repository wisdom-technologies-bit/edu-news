import Redis from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * The client type is intentionally loose so an in-memory implementation
 * (`ioredis-mock`, enabled with REDIS_URL=mock://) can stand in during local
 * development and tests. The public surface we use is small and stable:
 * get/set/exists/del/ping/pipeline/zadd/zrevrangebyscore/zcard/zremrangeby*,
 * sadd/smembers/hincrby.
 */
type RedisClient = InstanceType<typeof Redis>;

let client: RedisClient | null = null;

/** Namespaced key builder. */
export const keys = {
  prefix: config.redis.prefix,
  article: (id: string) => `${config.redis.prefix}:article:${id}`,
  /** ZSET of article ids scored by published_at epoch seconds. */
  index: () => `${config.redis.prefix}:index`,
  /** url hash → article id (exact-duplicate guard). */
  url: (urlHash: string) => `${config.redis.prefix}:url:${urlHash}`,
  /** title fingerprint → article id (cross-publisher duplicate guard). */
  fingerprint: (fp: string) => `${config.redis.prefix}:fp:${fp}`,
  /** Per-source fetch state (etag, last run, health). */
  sourceState: (sourceId: string) => `${config.redis.prefix}:source:${sourceId}`,
  /** All source ids with state. */
  sourceSet: () => `${config.redis.prefix}:sources`,
  /** Ingestion lock. */
  ingestLock: () => `${config.redis.prefix}:lock:ingest`,
  /** Cached API responses. */
  cache: (hash: string) => `${config.redis.prefix}:cache:${hash}`,
  /** Aggregate counters. */
  stats: () => `${config.redis.prefix}:stats`,
  /** Last successful ingestion run summary. */
  lastRun: () => `${config.redis.prefix}:lastRun`,
};

function buildOptions() {
  const base = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times: number) => Math.min(times * 200, 3000),
  };

  if (config.redis.url && !isMockRedis()) {
    return { ...base, ...parseRedisUrl(config.redis.url) };
  }

  return {
    ...base,
    host: config.redis.host,
    port: config.redis.port,
    db: config.redis.db,
    ...(config.redis.password ? { password: config.redis.password } : {}),
    ...(config.redis.tls ? { tls: {} } : {}),
  };
}

/** ioredis accepts a URL string directly; this keeps typing explicit. */
function parseRedisUrl(url: string): { host: string; port: number; db: number; password?: string; tls?: object } {
  const u = new URL(url);
  const dbPath = u.pathname.replace(/^\//, '');
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db: dbPath ? Number(dbPath) : 0,
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export function isMockRedis(): boolean {
  return config.redis.url.startsWith('mock://');
}

/**
 * Create the Redis client. `mock://` selects the in-memory implementation so
 * the API and CLI can run with no Redis server installed — useful for CI
 * smoke tests, local demos and evaluation.
 */
async function createClient(): Promise<RedisClient> {
  if (isMockRedis()) {
    const mod = (await import('ioredis-mock')) as unknown as { default: new () => RedisClient };
    const MockRedis = mod.default;
    logger.warn('using in-memory Redis (REDIS_URL=mock://) — data is not persisted');
    return new MockRedis();
  }
  return new Redis(buildOptions());
}

/**
 * Initialise the client. Must be awaited once at startup; `getRedis()` then
 * returns the ready client synchronously.
 */
export async function initRedis(): Promise<RedisClient> {
  if (client) return client;

  client = await createClient();

  if (typeof client.on === 'function') {
    client.on('connect', () => logger.info({ host: config.redis.host }, 'redis connected'));
    client.on('ready', () => logger.debug('redis ready'));
    client.on('error', (err: Error) => logger.error({ err: err.message }, 'redis error'));
    client.on('reconnecting', () => logger.warn('redis reconnecting'));
    client.on('end', () => logger.warn('redis connection closed'));
  }

  return client;
}

/**
 * Synchronous accessor. Returns the client created by `initRedis()`; callers
 * inside request handlers rely on startup having awaited initialisation.
 */
export function getRedis(): RedisClient {
  if (!client) {
    throw new Error('Redis not initialised: await initRedis() during startup');
  }
  return client;
}

export async function pingRedis(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    const redis = await initRedis();
    const pong = await redis.ping();
    return { ok: pong === 'PONG', latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    const c = client;
    client = null;
    await c.quit().catch(() => c.disconnect());
  }
}

/**
 * Acquire the ingestion lock so overlapping runs cannot double-write.
 * The lock expires automatically, so a crashed run cannot wedge the service.
 */
export async function acquireIngestLock(ttlSeconds = 900): Promise<string | null> {
  const redis = getRedis();
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const ok = await redis.set(keys.ingestLock(), token, 'EX', ttlSeconds, 'NX');
  return ok === 'OK' ? token : null;
}

export async function releaseIngestLock(token: string): Promise<void> {
  const redis = getRedis();
  const current = await redis.get(keys.ingestLock());
  if (current === token) await redis.del(keys.ingestLock());
}
