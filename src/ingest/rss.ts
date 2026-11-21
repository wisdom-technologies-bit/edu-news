import Parser from 'rss-parser';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { SourceDef } from '../sources/types.js';
import { parseDate, sanitizePublishedAt } from '../util/dates.js';
import { fetchUrl } from './fetcher.js';
import type { DiscoverResult, RawItem } from './types.js';

interface FeedItem {
  title?: string;
  link?: string;
  guid?: string;
  pubDate?: string;
  isoDate?: string;
  content?: string;
  contentSnippet?: string;
  summary?: string;
  'content:encoded'?: string;
  categories?: string[];
  enclosure?: { url?: string; type?: string };
  mediaContent?: Array<{ $?: { url?: string; medium?: string } }>;
  mediaThumbnail?: Array<{ $?: { url?: string } }>;
  creator?: string;
  author?: string;
  dc?: { creator?: string };
  [key: string]: unknown;
}

const parser = new Parser<Record<string, unknown>, FeedItem>({
  customFields: {
    item: [
      ['content:encoded', 'content:encoded'],
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['dc:creator', 'dc'],
    ],
  },
});

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj._ === 'string') return obj._;
  }
  return '';
}

function pickImage(item: FeedItem): string | null {
  const enclosure = item.enclosure?.url;
  if (enclosure && /^https?:/.test(enclosure)) return enclosure;

  const media = item.mediaContent;
  if (Array.isArray(media)) {
    for (const entry of media) {
      const url = entry?.$?.url;
      if (url && /^https?:/.test(url)) return url;
    }
  }
  const thumbs = item.mediaThumbnail;
  if (Array.isArray(thumbs)) {
    for (const entry of thumbs) {
      const url = entry?.$?.url;
      if (url && /^https?:/.test(url)) return url;
    }
  }

  // Last resort: first <img> in the body.
  const body = textOf(item['content:encoded']) || item.content || '';
  const m = body.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m && /^https?:/.test(m[1])) return m[1];

  return null;
}

function authorOf(item: FeedItem): string | null {
  const candidate =
    textOf(item.dc?.creator) ||
    textOf(item.creator) ||
    textOf(item.author) ||
    '';
  const cleaned = candidate.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

/**
 * Discover articles from a publisher's RSS/Atom feed(s).
 *
 * Every configured feed is merged rather than stopping at the first success.
 * This matters in practice: Premium Times' education category feed is often
 * weeks stale while its main feed is current, and Vanguard exposes several
 * section feeds that each carry different stories.
 */
export async function discoverFromFeed(
  source: SourceDef,
  conditional: { etag?: string; lastModified?: string } = {},
): Promise<DiscoverResult> {
  const started = Date.now();
  const feeds = source.feeds ?? [];

  if (feeds.length === 0) {
    return {
      sourceId: source.id, items: [], ok: false, status: 0,
      error: 'no feed configured', durationMs: 0, notModified: false,
    };
  }

  const errors: string[] = [];
  const now = new Date();
  const merged: RawItem[] = [];
  const seenUrls = new Set<string>();

  let anyOk = false;
  let allNotModified = true;
  let firstStatus = 0;
  let etag: string | undefined;
  let lastModified: string | undefined;

  for (const [index, feedUrl] of feeds.entries()) {
    // Conditional headers only apply to the primary feed (the one we cached).
    const useConditional = index === 0 ? conditional : {};

    const res = await fetchUrl(feedUrl, {
      etag: useConditional.etag,
      lastModified: useConditional.lastModified,
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    });

    if (index === 0) {
      firstStatus = res.status;
      etag = res.etag;
      lastModified = res.lastModified;
    }

    if (res.ok && res.status === 304) {
      continue; // unchanged since last run; keep allNotModified true
    }

    allNotModified = false;

    if (!res.ok || !res.body) {
      errors.push(`${feedUrl}: ${res.error ?? `HTTP ${res.status}`}`);
      continue;
    }

    let feed: Awaited<ReturnType<typeof parser.parseString>>;
    try {
      feed = await parser.parseString(res.body);
    } catch (err) {
      errors.push(`${feedUrl}: parse failed (${(err as Error).message.slice(0, 80)})`);
      continue;
    }

    anyOk = true;
    const rawItems = (feed.items ?? []) as FeedItem[];

    for (const item of rawItems) {
      const link = item.link || (typeof item.guid === 'string' ? item.guid : '');
      if (!link || !/^https?:/.test(link)) continue;

      const title = (item.title ?? '').replace(/\s+/g, ' ').trim();
      if (!title) continue;

      if (seenUrls.has(link)) continue;
      seenUrls.add(link);

      const date = parseDate(item.isoDate ?? item.pubDate ?? null);
      const publishedAt = date ? sanitizePublishedAt(date, now) : null;

      const fullContent = textOf(item['content:encoded']) || textOf(item.content);
      const summary = textOf(item.contentSnippet) || textOf(item.summary) || '';

      merged.push({
        sourceId: source.id,
        url: link,
        title,
        publishedAt,
        feedSummary: summary,
        feedContent: fullContent,
        // Some feeds (Blogger/Atom) yield category objects rather than strings;
        // coerce here so downstream joins and regexes never see a non-primitive.
        feedCategories: Array.isArray(item.categories)
          ? item.categories
              .map((c: unknown) => (typeof c === 'string' ? c : textOf(c)))
              .filter((c): c is string => typeof c === 'string' && c.length > 0)
          : [],
        enclosureImage: pickImage(item),
        author: authorOf(item),
      });
    }

    logger.debug(
      { source: source.id, feedUrl, items: rawItems.length, ms: Date.now() - started },
      'feed parsed',
    );
  }

  // Every feed reported 304: nothing to do this pass.
  if (allNotModified && feeds.length > 0 && errors.length === 0) {
    return {
      sourceId: source.id, items: [], ok: true, status: 304,
      durationMs: Date.now() - started, notModified: true,
      etag, lastModified,
    };
  }

  return {
    sourceId: source.id,
    items: merged,
    ok: anyOk,
    status: firstStatus,
    error: errors.length ? errors.join(' | ').slice(0, 300) : undefined,
    durationMs: Date.now() - started,
    notModified: false,
    etag,
    lastModified,
  };
}

/** Best available body from the feed alone. */
export function feedBody(item: RawItem): string {
  const full = item.feedContent?.trim() ?? '';
  if (full.length >= config.ingest.minFeedContentChars) return full;
  return item.feedSummary?.trim() || full;
}
