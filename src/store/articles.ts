import { config } from '../config.js';
import { getRedis, keys } from './redis.js';
import type { SourceTier } from '../sources/types.js';

/** How the article body was obtained. */
export type ExtractionMode = 'feed_full' | 'page_full' | 'excerpt_only';

export interface StoredArticle {
  id: string;
  title: string;
  excerpt: string;
  /** Markdown body, publisher formatting preserved, images inline. */
  content: string;
  source_id: string;
  source_name: string;
  source_url: string;
  image_url: string | null;
  published_at: string;
  category: string;
  institution: string | null;
  country: string;
  original_language: string;
  is_verified: boolean;

  // ── internal fields (not all are exposed by the public API) ──
  images: string[];
  tags: string[];
  author: string | null;
  tier: SourceTier;
  word_count: number;
  extraction: ExtractionMode;
  relevance_score: number;
  canonical_url: string;
  fingerprint: string;
  fetched_at: string;
}

/** The exact shape the API contract promises, plus the id. */
export interface PublicArticle {
  id: string;
  title: string;
  excerpt: string;
  content: string;
  source_name: string;
  source_url: string;
  image_url: string | null;
  published_at: string;
  category: string;
  institution: string | null;
  country: string;
  original_language: string;
  is_verified: boolean;
}

/** Normalise to second-precision ISO-8601 UTC so the contract never varies. */
function normaliseIso(value: string): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function toPublic(a: StoredArticle): PublicArticle {
  return {
    id: a.id,
    title: a.title,
    excerpt: a.excerpt,
    content: a.content,
    source_name: a.source_name,
    source_url: a.source_url,
    image_url: a.image_url,
    published_at: normaliseIso(a.published_at),
    category: a.category,
    institution: a.institution,
    country: a.country,
    original_language: a.original_language,
    is_verified: a.is_verified,
  };
}

const ARTICLE_TTL_SECONDS = () => config.ingest.retentionDays * 86_400;

/** Persist an article, index it by publication time, and register dedupe keys. */
export async function saveArticle(article: StoredArticle): Promise<void> {
  const redis = getRedis();
  const ttl = ARTICLE_TTL_SECONDS();
  const score = Math.floor(new Date(article.published_at).getTime() / 1000);

  const pipeline = redis.pipeline();
  pipeline.set(keys.article(article.id), JSON.stringify(article), 'EX', ttl);
  pipeline.zadd(keys.index(), score, article.id);
  pipeline.set(keys.url(hashKey(article.canonical_url)), article.id, 'EX', ttl);
  if (article.fingerprint) {
    pipeline.set(keys.fingerprint(article.fingerprint), article.id, 'EX', ttl);
  }
  await pipeline.exec();
}

/** True when this exact canonical URL has already been stored. */
export async function urlSeen(canonicalUrl: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.exists(keys.url(hashKey(canonicalUrl)));
  return exists === 1;
}

/** Article id already stored for this title fingerprint, if any. */
export async function fingerprintOwner(fingerprint: string): Promise<string | null> {
  if (!fingerprint) return null;
  const redis = getRedis();
  return redis.get(keys.fingerprint(fingerprint));
}

export async function getArticle(id: string): Promise<StoredArticle | null> {
  const redis = getRedis();
  const raw = await redis.get(keys.article(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredArticle;
  } catch {
    return null;
  }
}

/** Article ids published within the window, newest first. */
export async function recentIds(days: number, limit = 5000): Promise<string[]> {
  const redis = getRedis();
  const minScore = Math.floor((Date.now() - days * 86_400_000) / 1000);
  const ids = await redis.zrevrangebyscore(keys.index(), '+inf', minScore, 'LIMIT', 0, limit);
  return ids;
}

/** Hydrate many ids in one round-trip. */
export async function getArticles(ids: string[]): Promise<StoredArticle[]> {
  if (ids.length === 0) return [];
  const redis = getRedis();
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.get(keys.article(id));
  const results = await pipeline.exec();

  const out: StoredArticle[] = [];
  for (const [err, raw] of results ?? []) {
    if (err || typeof raw !== 'string' || !raw) continue;
    try {
      out.push(JSON.parse(raw) as StoredArticle);
    } catch {
      /* skip corrupt entry */
    }
  }
  return out;
}

/** Remove index entries whose article payload has expired. */
export async function pruneIndex(): Promise<number> {
  const redis = getRedis();
  const minScore = Math.floor((Date.now() - config.ingest.retentionDays * 86_400_000) / 1000);

  // Drop anything past retention.
  const removedByAge = await redis.zremrangebyscore(keys.index(), '-inf', minScore);

  // Trim the tail if the index grows beyond the configured cap.
  const size = await redis.zcard(keys.index());
  let removedBySize = 0;
  if (size > config.ingest.maxIndexSize) {
    removedBySize = await redis.zremrangebyrank(keys.index(), 0, size - config.ingest.maxIndexSize - 1);
  }

  return removedByAge + removedBySize;
}

export interface QueryOptions {
  days: number;
  limit: number;
  offset: number;
  sources?: string[];
  categories?: string[];
  institutions?: string[];
  countries?: string[];
  query?: string;
  verifiedOnly?: boolean;
  sort: 'newest' | 'oldest' | 'relevance';
}

export interface QueryResult {
  articles: StoredArticle[];
  total: number;
}

/** In-window article count for a set of filters (used for pagination meta). */
export async function queryArticles(opts: QueryOptions): Promise<QueryResult> {
  // Pull the window, then filter. A 10-day Nigerian education window is small
  // enough (hundreds, not millions) that filtering in memory is both simpler
  // and faster than maintaining per-facet Redis indexes.
  const ids = await recentIds(opts.days, 5000);
  const all = await getArticles(ids);

  const sourceSet = opts.sources?.length ? new Set(opts.sources) : null;
  const categorySet = opts.categories?.length ? new Set(opts.categories.map((c) => c.toLowerCase())) : null;
  const institutionSet = opts.institutions?.length
    ? new Set(opts.institutions.map((i) => i.toLowerCase()))
    : null;
  const countrySet = opts.countries?.length ? new Set(opts.countries.map((c) => c.toLowerCase())) : null;
  const q = opts.query?.trim().toLowerCase();

  let filtered = all.filter((a) => {
    if (sourceSet && !sourceSet.has(a.source_id)) return false;
    if (categorySet && !categorySet.has(a.category.toLowerCase())) return false;
    if (institutionSet) {
      const inst = (a.institution ?? '').toLowerCase();
      if (![...institutionSet].some((i) => inst.includes(i))) return false;
    }
    if (countrySet && !countrySet.has(a.country.toLowerCase())) return false;
    if (opts.verifiedOnly && !a.is_verified) return false;
    if (q) {
      const haystack = `${a.title} ${a.excerpt} ${a.content} ${a.institution ?? ''} ${a.tags.join(' ')}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  filtered = sortArticles(filtered, opts.sort);

  const total = filtered.length;
  const page = filtered.slice(opts.offset, opts.offset + opts.limit);
  return { articles: page, total };
}

export function sortArticles(list: StoredArticle[], sort: QueryOptions['sort']): StoredArticle[] {
  const copy = [...list];
  switch (sort) {
    case 'oldest':
      return copy.sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
    case 'relevance':
      return copy.sort((a, b) => {
        if (b.relevance_score !== a.relevance_score) return b.relevance_score - a.relevance_score;
        return Date.parse(b.published_at) - Date.parse(a.published_at);
      });
    case 'newest':
    default:
      return copy.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  }
}

/** Distinct categories / institutions / sources in the window, for facets. */
export async function facets(days: number): Promise<{
  categories: Record<string, number>;
  institutions: Record<string, number>;
  sources: Record<string, number>;
}> {
  const ids = await recentIds(days, 5000);
  const all = await getArticles(ids);

  const categories: Record<string, number> = {};
  const institutions: Record<string, number> = {};
  const sources: Record<string, number> = {};

  for (const a of all) {
    categories[a.category] = (categories[a.category] ?? 0) + 1;
    sources[a.source_id] = (sources[a.source_id] ?? 0) + 1;
    if (a.institution) institutions[a.institution] = (institutions[a.institution] ?? 0) + 1;
  }

  return { categories, institutions, sources };
}

/** Aggregate counters for /api/stats. */
export async function stats(days: number): Promise<{
  total: number;
  verified: number;
  withImages: number;
  fullContent: number;
  bySource: Record<string, number>;
  byCategory: Record<string, number>;
  newest: string | null;
  oldest: string | null;
}> {
  const ids = await recentIds(days, 5000);
  const all = await getArticles(ids);

  const bySource: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let verified = 0;
  let withImages = 0;
  let fullContent = 0;
  let newest: string | null = null;
  let oldest: string | null = null;

  for (const a of all) {
    bySource[a.source_id] = (bySource[a.source_id] ?? 0) + 1;
    byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
    if (a.is_verified) verified++;
    if (a.image_url) withImages++;
    if (a.extraction !== 'excerpt_only') fullContent++;
    if (!newest || a.published_at > newest) newest = a.published_at;
    if (!oldest || a.published_at < oldest) oldest = a.published_at;
  }

  return { total: all.length, verified, withImages, fullContent, bySource, byCategory, newest, oldest };
}

/** Short stable hash used for dedupe keys and response caching. */
export function hashKey(input: string): string {
  // djb2 — fast, non-cryptographic, adequate for cache keys.
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Normalised title used to spot the same story across publishers. */
export function titleFingerprint(title: string): string {
  const normalised = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalised ? hashKey(normalised).padStart(7, '0') : '';
}
