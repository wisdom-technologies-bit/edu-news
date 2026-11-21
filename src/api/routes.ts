import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { SOURCES, ACTIVE_SOURCES, getSource } from '../sources/registry.js';
import {
  facets,
  getArticle,
  hashKey,
  queryArticles,
  stats,
  toPublic,
  type QueryOptions,
} from '../store/articles.js';
import { getRedis, keys, pingRedis } from '../store/redis.js';
import { lastRunReport, runIngestion, sourceHealth } from '../ingest/pipeline.js';
import { humanAgo } from '../util/dates.js';

export const api = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Split a repeatable/comma-separated query param into a clean array. */
function asArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value.map(String) : [String(value)];
  const parts = raw.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function boolParam(value: unknown): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return ['1', 'true', 'yes'].includes(String(value).toLowerCase());
}

/** Read-through cache for assembled API responses. */
async function cached(key: string, ttlSeconds: number, build: () => Promise<unknown>): Promise<unknown> {
  if (ttlSeconds <= 0) return build();
  const redis = getRedis();
  try {
    const hit = await redis.get(keys.cache(key));
    if (hit) return JSON.parse(hit);
  } catch {
    /* cache read is best-effort */
  }
  const value = await build();
  try {
    await redis.set(keys.cache(key), JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    /* cache write is best-effort */
  }
  return value;
}

/** Simple fixed-window rate limiter (per IP). */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const limit = config.server.rateLimitPerMinute;
  if (limit <= 0) return next();

  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(limit - 1));
    return next();
  }

  bucket.count++;
  const remaining = Math.max(0, limit - bucket.count);
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));

  if (bucket.count > limit) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    res.status(429).json({ error: 'rate_limit_exceeded', message: 'Too many requests. Slow down.' });
    return;
  }
  next();
}

api.use(rateLimit);

// Periodically clear expired rate buckets.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) if (now > bucket.resetAt) rateBuckets.delete(ip);
}, 120_000).unref();

// ─── GET /api/news ──────────────────────────────────────────────────────────

const newsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['newest', 'oldest', 'relevance']).optional(),
  verified: z.string().optional(),
});

api.get('/news', async (req: Request, res: Response) => {
  const parsed = newsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_query',
      message: 'Invalid query parameters',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const q = parsed.data;
  const days = q.days ?? config.api.defaultDays;
  const limit = Math.min(q.limit ?? config.api.defaultLimit, config.api.maxLimit);
  const offset = q.offset ?? ((q.page ?? 1) - 1) * limit;

  const opts: QueryOptions = {
    days,
    limit,
    offset,
    sources: asArray(req.query.source ?? req.query.sources),
    categories: asArray(req.query.category ?? req.query.categories),
    institutions: asArray(req.query.institution),
    countries: asArray(req.query.country),
    query: typeof req.query.q === 'string' ? req.query.q : undefined,
    verifiedOnly: boolParam(q.verified),
    sort: q.sort ?? 'newest',
  };

  const cacheKey = hashKey(JSON.stringify(opts));

  try {
    const result = (await cached(cacheKey, config.api.responseCacheSeconds, async () => {
      const { articles, total } = await queryArticles(opts);
      return {
        meta: {
          count: articles.length,
          total,
          days,
          page: Math.floor(offset / limit) + 1,
          limit,
          offset,
          sort: opts.sort,
          has_more: offset + articles.length < total,
          generated_at: new Date().toISOString(),
          window: {
            from: new Date(Date.now() - days * 86_400_000).toISOString(),
            to: new Date().toISOString(),
          },
          filters: {
            sources: opts.sources ?? null,
            categories: opts.categories ?? null,
            institutions: opts.institutions ?? null,
            countries: opts.countries ?? null,
            query: opts.query ?? null,
            verified_only: opts.verifiedOnly ?? false,
          },
        },
        data: articles.map(toPublic),
      };
    })) as Record<string, unknown>;

    res.setHeader('Cache-Control', `public, max-age=${Math.min(config.api.responseCacheSeconds, 300)}`);
    return res.json(result);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'GET /api/news failed');
    return res.status(500).json({ error: 'internal_error', message: 'Failed to read news from cache.' });
  }
});

// ─── GET /api/news/:id ──────────────────────────────────────────────────────

api.get('/news/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!/^[a-f0-9]{6,40}$/i.test(id)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Article id must be a hex string.' });
  }

  try {
    const article = await getArticle(id);
    if (!article) {
      return res.status(404).json({ error: 'not_found', message: 'Article not found or expired from cache.' });
    }
    return res.json({ data: toPublic(article) });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'GET /api/news/:id failed');
    return res.status(500).json({ error: 'internal_error', message: 'Failed to read article.' });
  }
});

// ─── GET /api/sources ───────────────────────────────────────────────────────

api.get('/sources', async (_req: Request, res: Response) => {
  try {
    const health = await sourceHealth();

    const data = SOURCES.map((source) => {
      const state = health[source.id];
      return {
        id: source.id,
        name: source.name,
        homepage: source.homepage,
        tier: source.tier,
        discovery: source.discovery,
        content_strategy: source.content,
        category: source.defaultCategory,
        country: source.country,
        language: source.language,
        institution: source.institution ?? null,
        needs_browser: source.needsBrowser ?? false,
        active: !source.disabled,
        disabled_reason: source.disabledReason ?? null,
        notes: source.notes ?? null,
        health: state
          ? {
              last_run: state.last_run,
              last_ok: state.last_ok,
              last_error: state.last_error,
              consecutive_failures: state.consecutive_failures,
              last_discovered: state.last_discovered ?? 0,
              last_stored: state.last_stored ?? 0,
            }
          : null,
      };
    });

    return res.json({
      meta: {
        total: data.length,
        active: data.filter((s) => s.active).length,
        healthy: data.filter((s) => s.health && s.health.consecutive_failures === 0).length,
        generated_at: new Date().toISOString(),
      },
      data,
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'GET /api/sources failed');
    return res.status(500).json({ error: 'internal_error', message: 'Failed to read source health.' });
  }
});

// ─── GET /api/categories + /api/institutions (facets) ───────────────────────

api.get('/facets', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || config.api.defaultDays, 30);
  try {
    const result = await cached(`facets:${days}`, 120, () => facets(days));
    return res.json({ meta: { days, generated_at: new Date().toISOString() }, data: result });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'GET /api/facets failed');
    return res.status(500).json({ error: 'internal_error', message: 'Failed to compute facets.' });
  }
});

// ─── GET /api/stats ─────────────────────────────────────────────────────────

api.get('/stats', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || config.api.defaultDays, 30);
  try {
    const [aggregate, lastRun, redis] = await Promise.all([
      stats(days),
      lastRunReport(),
      pingRedis(),
    ]);

    return res.json({
      data: {
        window_days: days,
        articles: aggregate.total,
        verified: aggregate.verified,
        with_images: aggregate.withImages,
        full_content: aggregate.fullContent,
        by_source: aggregate.bySource,
        by_category: aggregate.byCategory,
        newest_article: aggregate.newest,
        oldest_article: aggregate.oldest,
        newest_age: aggregate.newest ? humanAgo(new Date(aggregate.newest)) : null,
        last_ingestion: lastRun
          ? {
              finished_at: lastRun.finished_at,
              duration_ms: lastRun.duration_ms,
              stored: lastRun.stored,
              discovered: lastRun.discovered,
              sources_ok: lastRun.sources_ok,
              sources_failed: lastRun.sources_failed,
            }
          : null,
        redis: { ok: redis.ok, latency_ms: redis.latencyMs },
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'GET /api/stats failed');
    return res.status(500).json({ error: 'internal_error', message: 'Failed to compute stats.' });
  }
});

// ─── GET /api/health ────────────────────────────────────────────────────────

api.get('/health', async (_req: Request, res: Response) => {
  const redis = await pingRedis();
  const healthy = redis.ok;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    version: config.version,
    uptime_seconds: Math.round(process.uptime()),
    redis: { ok: redis.ok, latency_ms: redis.latencyMs, error: redis.error ?? null },
    sources: { total: SOURCES.length, active: ACTIVE_SOURCES.length },
    config: {
      lookback_days: config.ingest.lookbackDays,
      retention_days: config.ingest.retentionDays,
      ingest_interval_minutes: config.ingest.intervalMinutes,
      browser_renderer: config.extraction.enableBrowserRenderer,
    },
  });
});

// ─── POST /api/ingest ───────────────────────────────────────────────────────

api.post('/ingest', async (req: Request, res: Response) => {
  const expected = config.security.ingestToken;

  if (!expected) {
    return res.status(404).json({
      error: 'not_enabled',
      message: 'Manual ingestion is disabled. Set INGEST_TOKEN to enable this endpoint.',
    });
  }

  const provided = req.get('x-ingest-token') ?? '';
  if (provided !== expected) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid or missing x-ingest-token header.' });
  }

  try {
    const includeDiscovery = boolParam(req.query.discovery) ?? false;
    const report = await runIngestion({ includeDiscovery });
    return res.json({ data: report });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'POST /api/ingest failed');
    return res.status(500).json({ error: 'internal_error', message: 'Ingestion failed.' });
  }
});

// ─── 404 for unknown API routes ─────────────────────────────────────────────

api.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'not_found',
    message: 'Unknown endpoint. See /api or the README for available routes.',
  });
});

export { getSource };
