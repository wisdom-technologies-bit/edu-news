import 'dotenv/config';

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const contactEmail = str('CONTACT_EMAIL');
/**
 * Several Nigerian publishers (MySchoolGist, Vanguard, Tribune) return 403 to
 * self-identifying bot user-agents but serve their RSS feeds to a normal
 * browser string. The default therefore presents as a desktop browser; set
 * USER_AGENT to override. Requests stay polite via per-host throttling,
 * conditional GET and the configured crawl window.
 */
const baseUserAgent = str(
  'USER_AGENT',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
);

export const config = {
  env: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV', 'development') === 'production',

  server: {
    port: int('PORT', 8080),
    host: str('HOST', '0.0.0.0'),
    corsOrigins: list('CORS_ORIGINS', ['*']),
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 120),
  },

  redis: {
    url: str('REDIS_URL'),
    host: str('REDIS_HOST', '127.0.0.1'),
    port: int('REDIS_PORT', 6379),
    password: str('REDIS_PASSWORD'),
    db: int('REDIS_DB', 0),
    tls: bool('REDIS_TLS', false),
    prefix: str('REDIS_PREFIX', 'edunews'),
  },

  ingest: {
    lookbackDays: int('INGEST_LOOKBACK_DAYS', 10),
    retentionDays: int('RETENTION_DAYS', 21),
    maxIndexSize: int('MAX_INDEX_SIZE', 8000),
    intervalMinutes: int('INGEST_INTERVAL_MINUTES', 30),
    onBoot: bool('INGEST_ON_BOOT', true),
    concurrency: int('FETCH_CONCURRENCY', 8),
    timeoutMs: int('REQUEST_TIMEOUT_MS', 15000),
    perHostDelayMs: int('PER_HOST_DELAY_MS', 750),
    retries: int('FETCH_RETRIES', 2),
    minFeedContentChars: int('MIN_FEED_CONTENT_CHARS', 1200),
    minContentCharsForVerify: int('MIN_CONTENT_CHARS_FOR_VERIFY', 400),
    maxContentChars: int('MAX_CONTENT_CHARS', 60000),
  },

  api: {
    defaultDays: int('API_DEFAULT_DAYS', 10),
    defaultLimit: int('API_DEFAULT_LIMIT', 20),
    maxLimit: int('API_MAX_LIMIT', 100),
    responseCacheSeconds: int('RESPONSE_CACHE_SECONDS', 60),
  },

  security: {
    ingestToken: str('INGEST_TOKEN'),
  },

  extraction: {
    enableBrowserRenderer: bool('ENABLE_BROWSER_RENDERER', false),
  },

  log: {
    level: str('LOG_LEVEL', 'info'),
    pretty: bool('LOG_PRETTY', false),
  },

  userAgent: contactEmail
    ? `${baseUserAgent} (contact: ${contactEmail})`
    : baseUserAgent,

  version: '1.0.0',
} as const;

export type Config = typeof config;

/** Validate cross-field constraints and fail fast on impossible settings. */
export function assertConfig(): void {
  if (config.ingest.retentionDays < config.ingest.lookbackDays) {
    throw new Error(
      `RETENTION_DAYS (${config.ingest.retentionDays}) must be >= INGEST_LOOKBACK_DAYS (${config.ingest.lookbackDays}); ` +
        'otherwise articles are evicted before the ingestion window can use them.',
    );
  }
  if (config.ingest.concurrency < 1 || config.ingest.concurrency > 32) {
    throw new Error('FETCH_CONCURRENCY must be between 1 and 32');
  }
  if (!config.redis.url && !config.redis.host) {
    throw new Error('Redis is not configured: set REDIS_URL or REDIS_HOST');
  }
}
