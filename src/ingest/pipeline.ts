import pLimit from 'p-limit';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ACTIVE_SOURCES, PUBLISHER_HOSTS, getSource } from '../sources/registry.js';
import { DISCOVERY_QUERIES } from '../sources/types.js';
import type { SourceDef } from '../sources/types.js';
import { classify, isVerifiable } from '../sources/classify.js';
import { articleId, canonicalUrl, sha1 } from '../util/hash.js';
import { isWithinDays, iso, parseDate } from '../util/dates.js';
import { acquireIngestLock, getRedis, keys, releaseIngestLock } from '../store/redis.js';
import {
  fingerprintOwner,
  pruneIndex,
  saveArticle,
  titleFingerprint,
  urlSeen,
  type ExtractionMode,
  type StoredArticle,
} from '../store/articles.js';
import { extractArticle, extractArticleWithBrowser } from './extract.js';
import { discoverFromFeed } from './rss.js';
import { discoverFromHtmlList } from './htmllist.js';
import { discoverFromGoogleNews, discoverTopicQueries } from './googlenews.js';
import { firstImage, htmlToMarkdown } from './markdown.js';
import { stripHtml, truncate } from './fetcher.js';
import type { DiscoverResult, RawItem } from './types.js';

export interface SourceReport {
  source_id: string;
  source_name: string;
  discovered: number;
  new_articles: number;
  skipped_duplicate: number;
  skipped_irrelevant: number;
  skipped_out_of_window: number;
  failed_extractions: number;
  ok: boolean;
  error?: string;
  duration_ms: number;
}

export interface IngestReport {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  sources_total: number;
  sources_ok: number;
  sources_failed: number;
  discovered: number;
  stored: number;
  skipped_duplicate: number;
  skipped_irrelevant: number;
  skipped_out_of_window: number;
  failed_extractions: number;
  pruned_index_entries: number;
  reports: SourceReport[];
}

interface SourceState {
  last_run: string;
  last_ok: string | null;
  last_error: string | null;
  consecutive_failures: number;
  etag?: string;
  last_modified?: string;
  last_discovered?: number;
  last_stored?: number;
}

/** Persisted health/conditional-GET state for one source. */
async function loadSourceState(sourceId: string): Promise<SourceState | null> {
  const redis = getRedis();
  const raw = await redis.get(keys.sourceState(sourceId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SourceState;
  } catch {
    return null;
  }
}

async function saveSourceState(sourceId: string, state: SourceState): Promise<void> {
  const redis = getRedis();
  const pipeline = redis.pipeline();
  pipeline.set(keys.sourceState(sourceId), JSON.stringify(state), 'EX', 30 * 86_400);
  pipeline.sadd(keys.sourceSet(), sourceId);
  await pipeline.exec();
}

/** Discovery dispatch per source type. */
async function discover(source: SourceDef): Promise<DiscoverResult> {
  const state = await loadSourceState(source.id);
  const conditional = state ? { etag: state.etag, lastModified: state.last_modified } : {};

  switch (source.discovery) {
    case 'rss':
      return discoverFromFeed(source, conditional);
    case 'html-list':
      return discoverFromHtmlList(source);
    case 'google-news':
      return discoverFromGoogleNews(source);
    default:
      return {
        sourceId: source.id, items: [], ok: false, status: 0,
        error: `unsupported discovery kind`, durationMs: 0, notModified: false,
      };
  }
}

interface BuildResult {
  article: StoredArticle | null;
  duplicate: boolean;
  irrelevant: boolean;
  extractionFailed: boolean;
}

/**
 * Turn one discovered item into a stored article: resolve the body, convert to
 * Markdown, classify, verify, then assemble the record.
 */
async function buildArticle(
  source: SourceDef,
  item: RawItem,
  now: Date,
): Promise<BuildResult> {
  const canonical = canonicalUrl(item.url, source.homepage);
  const id = articleId(canonical);

  // ── Exact-URL dedupe ────────────────────────────────────────────────────
  if (await urlSeen(canonical)) {
    return { article: null, duplicate: true, irrelevant: false, extractionFailed: false };
  }

  // ── Cross-publisher dedupe by title fingerprint ─────────────────────────
  const fingerprint = titleFingerprint(item.title);
  if (fingerprint) {
    const owner = await fingerprintOwner(fingerprint);
    if (owner && owner !== id) {
      return { article: null, duplicate: true, irrelevant: false, extractionFailed: false };
    }
  }

  // ── Body acquisition ────────────────────────────────────────────────────
  const feedBodyHtml = item.feedContent?.trim() || item.feedSummary?.trim() || '';
  const feedBodyChars = stripHtml(feedBodyHtml).length;

  let contentHtml = feedBodyHtml;
  let contentBaseUrl = canonical;
  let mode: ExtractionMode = 'feed_full';
  let pageLeadImage: string | null = null;
  let pageExcerpt: string | null = null;
  let extractionFailed = false;

  const shouldFetchPage = (() => {
    if (source.content === 'feed') return false;
    if (source.content === 'excerpt') return false;
    if (source.content === 'page') return true;
    // 'auto': fetch when the feed body is thin.
    return feedBodyChars < config.ingest.minFeedContentChars;
  })();

  if (shouldFetchPage) {
    const page = source.needsBrowser
      ? await extractArticleWithBrowser(canonical)
      : await extractArticle(canonical);

    if (page.ok && page.markdown.wordCount >= 30) {
      contentHtml = ''; // use the extracted Markdown directly
      mode = 'page_full';
      pageLeadImage = page.leadImage;
      pageExcerpt = page.excerpt;
      if (!item.publishedAt) {
        const metaDate = parseDate(page.publishedTime);
        if (metaDate) item.publishedAt = metaDate;
      }

      const md = page.markdown.markdown;
      return finalise({
        source, item, now, canonical, id, fingerprint,
        markdown: md, images: page.markdown.images,
        leadImage: pageLeadImage, pageExcerpt,
        mode: 'page_full', extractionFailed: false,
      });
    }

    // Page failed — fall back to whatever the feed gave us.
    extractionFailed = true;
    logger.debug(
      { source: source.id, url: canonical, status: page.status, error: page.error },
      'page extraction failed, using feed body',
    );
    if (feedBodyChars === 0) {
      return { article: null, duplicate: false, irrelevant: false, extractionFailed: true };
    }
    mode = 'excerpt_only';
  } else if (source.content === 'excerpt' || feedBodyChars < config.ingest.minContentCharsForVerify) {
    mode = 'excerpt_only';
  } else if (feedBodyChars >= config.ingest.minFeedContentChars) {
    mode = 'feed_full';
  }

  const converted = htmlToMarkdown(contentHtml, contentBaseUrl);

  return finalise({
    source, item, now, canonical, id, fingerprint,
    markdown: converted.markdown, images: converted.images,
    leadImage: pageLeadImage, pageExcerpt,
    mode, extractionFailed,
  });
}

interface FinaliseInput {
  source: SourceDef;
  item: RawItem;
  now: Date;
  canonical: string;
  id: string;
  fingerprint: string;
  markdown: string;
  images: string[];
  leadImage: string | null;
  pageExcerpt: string | null;
  mode: ExtractionMode;
  extractionFailed: boolean;
}

/** Classify, verify and assemble the stored record. */
function finalise(input: FinaliseInput): BuildResult {
  const { source, item, now, canonical, id, fingerprint, markdown, images } = input;

  const content = markdown.slice(0, config.ingest.maxContentChars);
  const contentChars = content.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[#*_>`|-]/g, '').trim().length;

  if (contentChars === 0) {
    return { article: null, duplicate: false, irrelevant: false, extractionFailed: true };
  }

  const excerptSource =
    input.pageExcerpt ||
    (item.feedSummary ? stripHtml(item.feedSummary) : '') ||
    stripHtml(content);
  const excerpt = truncate(excerptSource.replace(/\s+/g, ' ').trim(), 320);

  const classification = classify({
    title: item.title,
    excerpt,
    content,
    feedCategories: item.feedCategories,
    defaultCategory: source.defaultCategory,
    focus: source.focus,
    country: source.country,
  });

  if (!classification.relevant) {
    return { article: null, duplicate: false, irrelevant: true, extractionFailed: false };
  }

  const publishedAt = item.publishedAt ?? now;
  const withinWindow = isWithinDays(publishedAt, config.ingest.lookbackDays, now);

  const imageUrl =
    item.enclosureImage ||
    input.leadImage ||
    firstImage(content) ||
    null;

  const isVerified = isVerifiable({
    contentChars,
    minChars: config.ingest.minContentCharsForVerify,
    extraction: input.mode,
    tier: source.tier,
    publishedWithinWindow: withinWindow,
  });

  const article: StoredArticle = {
    id,
    title: item.title.slice(0, 400),
    excerpt,
    content,
    source_id: source.id,
    source_name: source.name,
    source_url: canonical,
    image_url: imageUrl,
    published_at: iso(publishedAt),
    category: classification.category,
    institution: classification.institution ?? source.institution ?? null,
    country: classification.country,
    original_language: source.language,
    is_verified: isVerified,

    images: images.slice(0, 40),
    tags: classification.tags,
    author: item.author,
    tier: source.tier,
    word_count: content.split(/\s+/).filter(Boolean).length,
    extraction: input.mode,
    relevance_score: classification.relevanceScore,
    canonical_url: canonical,
    fingerprint,
    fetched_at: iso(now),
  };

  return { article, duplicate: false, irrelevant: false, extractionFailed: input.extractionFailed };
}

/** Process one source end to end. */
async function runSource(source: SourceDef, now: Date, limit: ReturnType<typeof pLimit>): Promise<SourceReport> {
  const started = Date.now();
  const report: SourceReport = {
    source_id: source.id,
    source_name: source.name,
    discovered: 0,
    new_articles: 0,
    skipped_duplicate: 0,
    skipped_irrelevant: 0,
    skipped_out_of_window: 0,
    failed_extractions: 0,
    ok: false,
    duration_ms: 0,
  };

  const previous = await loadSourceState(source.id);

  // A browser-only publisher cannot produce article bodies without Playwright.
  // Skipping early avoids paying for Google News resolution that cannot be used.
  if (source.needsBrowser && !config.extraction.enableBrowserRenderer) {
    report.ok = false;
    report.error = 'requires ENABLE_BROWSER_RENDERER=true (Playwright + Chromium)';
    report.duration_ms = Date.now() - started;
    logger.debug({ source: source.id }, 'skipping browser-only source (renderer disabled)');
    return report;
  }

  let discovery: DiscoverResult;
  try {
    discovery = await discover(source);
  } catch (err) {
    report.error = (err as Error).message;
    report.duration_ms = Date.now() - started;
    await saveSourceState(source.id, {
      last_run: iso(now),
      last_ok: previous?.last_ok ?? null,
      last_error: report.error,
      consecutive_failures: (previous?.consecutive_failures ?? 0) + 1,
      etag: previous?.etag,
      last_modified: previous?.last_modified,
    });
    return report;
  }

  report.discovered = discovery.items.length;

  if (discovery.notModified) {
    report.ok = true;
    report.duration_ms = Date.now() - started;
    await saveSourceState(source.id, {
      last_run: iso(now),
      last_ok: iso(now),
      last_error: null,
      consecutive_failures: 0,
      etag: discovery.etag ?? previous?.etag,
      last_modified: discovery.lastModified ?? previous?.last_modified,
      last_discovered: 0,
      last_stored: 0,
    });
    return report;
  }

  // Only items inside the lookback window are worth extracting.
  const inWindow = discovery.items.filter((item) => {
    if (!item.publishedAt) return true; // undated: let extraction decide
    return isWithinDays(item.publishedAt, config.ingest.lookbackDays, now);
  });
  report.skipped_out_of_window = discovery.items.length - inWindow.length;

  // Build articles with bounded concurrency.
  const results = await Promise.all(
    inWindow.map((item) =>
      limit(async () => {
        try {
          return await buildArticle(source, item, now);
        } catch (err) {
          logger.debug({ source: source.id, err: (err as Error).message }, 'build failed');
          return { article: null, duplicate: false, irrelevant: false, extractionFailed: true } as BuildResult;
        }
      }),
    ),
  );

  for (const result of results) {
    if (result.duplicate) report.skipped_duplicate++;
    else if (result.irrelevant) report.skipped_irrelevant++;
    else if (result.extractionFailed && !result.article) report.failed_extractions++;
    else if (result.article) {
      try {
        await saveArticle(result.article);
        report.new_articles++;
      } catch (err) {
        logger.warn({ source: source.id, err: (err as Error).message }, 'failed to persist article');
        report.failed_extractions++;
      }
    } else {
      // Nothing usable came back (e.g. no body at all).
      report.failed_extractions++;
    }
  }

  report.ok = discovery.ok;
  report.error = discovery.error;
  report.duration_ms = Date.now() - started;

  await saveSourceState(source.id, {
    last_run: iso(now),
    last_ok: discovery.ok ? iso(now) : (previous?.last_ok ?? null),
    last_error: discovery.ok ? null : (discovery.error ?? 'unknown error'),
    consecutive_failures: discovery.ok ? 0 : (previous?.consecutive_failures ?? 0) + 1,
    etag: discovery.etag ?? previous?.etag,
    last_modified: discovery.lastModified ?? previous?.last_modified,
    last_discovered: report.discovered,
    last_stored: report.new_articles,
  });

  return report;
}

/**
 * Run a full ingestion pass across every active source.
 *
 * Sources are ordered authority → national → specialist so that when the same
 * story appears in several outlets, the most authoritative version is the one
 * that survives the title-fingerprint dedupe.
 */
export async function runIngestion(opts: { includeDiscovery?: boolean } = {}): Promise<IngestReport> {
  const startedAt = new Date();
  const lockToken = await acquireIngestLock();

  if (!lockToken) {
    logger.warn('ingestion already running; skipping this pass');
    return {
      started_at: iso(startedAt),
      finished_at: iso(new Date()),
      duration_ms: 0,
      sources_total: 0,
      sources_ok: 0,
      sources_failed: 0,
      discovered: 0,
      stored: 0,
      skipped_duplicate: 0,
      skipped_irrelevant: 0,
      skipped_out_of_window: 0,
      failed_extractions: 0,
      pruned_index_entries: 0,
      reports: [],
    };
  }

  const tierOrder = { authority: 0, national: 1, specialist: 2 } as const;

  // Optional restriction used by `npm run ingest -- --source=a,b`.
  const only = (process.env.INGEST_ONLY_SOURCES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const pool = only.length ? ACTIVE_SOURCES.filter((s) => only.includes(s.id)) : ACTIVE_SOURCES;

  const ordered = [...pool].sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

  const limit = pLimit(Math.max(1, config.ingest.concurrency));
  const reports: SourceReport[] = [];

  logger.info({ sources: ordered.length, lookbackDays: config.ingest.lookbackDays }, 'ingestion started');

  try {
    const perSource = await Promise.all(ordered.map((source) => runSource(source, startedAt, limit)));
    reports.push(...perSource);

    // Optional broad discovery pass over the topic queries.
    if (opts.includeDiscovery) {
      try {
        const hostMap = new Map<string, string>();
        for (const [host, def] of PUBLISHER_HOSTS) hostMap.set(host, def.id);

        const discovered = await discoverTopicQueries(
          DISCOVERY_QUERIES.map((q) => ({ id: q.id, query: q.query })),
          hostMap,
        );

        for (const item of discovered) {
          const source = getSource(item.sourceId);
          if (!source || source.disabled) continue;
          const result = await limit(async () => buildArticle(source, item, startedAt));
          if (result.article) {
            await saveArticle(result.article);
            const report = reports.find((r) => r.source_id === source.id);
            if (report) {
              report.new_articles++;
              report.discovered++;
            }
          }
        }
        logger.info({ discovered: discovered.length }, 'topic discovery pass complete');
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'topic discovery pass failed');
      }
    }

    const pruned = await pruneIndex();
    const finishedAt = new Date();

    const report: IngestReport = {
      started_at: iso(startedAt),
      finished_at: iso(finishedAt),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      sources_total: reports.length,
      sources_ok: reports.filter((r) => r.ok).length,
      sources_failed: reports.filter((r) => !r.ok).length,
      discovered: reports.reduce((n, r) => n + r.discovered, 0),
      stored: reports.reduce((n, r) => n + r.new_articles, 0),
      skipped_duplicate: reports.reduce((n, r) => n + r.skipped_duplicate, 0),
      skipped_irrelevant: reports.reduce((n, r) => n + r.skipped_irrelevant, 0),
      skipped_out_of_window: reports.reduce((n, r) => n + (r.skipped_out_of_window ?? 0), 0),
      failed_extractions: reports.reduce((n, r) => n + r.failed_extractions, 0),
      pruned_index_entries: pruned,
      reports,
    };

    const redis = getRedis();
    await redis.set(keys.lastRun(), JSON.stringify(report), 'EX', 7 * 86_400);
    await redis.hincrby(keys.stats(), 'runs', 1);
    await redis.hincrby(keys.stats(), 'stored_total', report.stored);

    logger.info(
      {
        durationMs: report.duration_ms,
        stored: report.stored,
        discovered: report.discovered,
        ok: report.sources_ok,
        failed: report.sources_failed,
      },
      'ingestion finished',
    );

    return report;
  } finally {
    await releaseIngestLock(lockToken);
  }
}

/** Last run summary, for /api/stats. */
export async function lastRunReport(): Promise<IngestReport | null> {
  const redis = getRedis();
  const raw = await redis.get(keys.lastRun());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IngestReport;
  } catch {
    return null;
  }
}

/** Per-source health for /api/sources. */
export async function sourceHealth(): Promise<Record<string, SourceState>> {
  const redis = getRedis();
  const ids = await redis.smembers(keys.sourceSet());
  const out: Record<string, SourceState> = {};
  if (ids.length === 0) return out;

  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.get(keys.sourceState(id));
  const results = await pipeline.exec();

  ids.forEach((id, index) => {
    const raw = results?.[index]?.[1];
    if (typeof raw === 'string' && raw) {
      try {
        out[id] = JSON.parse(raw) as SourceState;
      } catch {
        /* ignore */
      }
    }
  });

  return out;
}
