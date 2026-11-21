import Parser from 'rss-parser';
import { logger } from '../logger.js';
import { config } from '../config.js';
import type { SourceDef } from '../sources/types.js';
import { parseDate, sanitizePublishedAt } from '../util/dates.js';
import { fetchUrl } from './fetcher.js';
import type { DiscoverResult, RawItem } from './types.js';

/**
 * Google News RSS discovery.
 *
 * Used for publishers that block crawlers outright (Guardian Nigeria, TheCable)
 * or expose no feed at all (JAMB, NBTE, NCCE). Google News indexes them and
 * hands back a headline, timestamp and publisher host.
 *
 * Google wraps the real article in an opaque redirect
 * (news.google.com/rss/articles/CBMi…). `resolveGoogleNewsUrl` unwraps it:
 * the article page carries a signed pair (data-n-a-ts / data-n-a-sg) which the
 * batchexecute endpoint exchanges for the publisher URL. Results are cached so
 * each link is only unwrapped once.
 */

interface GoogleItem {
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  description?: string;
  source?: { $?: { url?: string } } | string;
  [key: string]: unknown;
}

const parser = new Parser<Record<string, unknown>, GoogleItem>({
  customFields: { item: [['source', 'source']] },
});

/** Resolved-URL cache: google url → publisher url (or '' when unresolvable). */
const resolveCache = new Map<string, string>();
const RESOLVE_CACHE_MAX = 2000;

function hostMatches(host: string, expected: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const e = expected.toLowerCase().replace(/^www\./, '');
  return h === e || h.endsWith(`.${e}`);
}

function sourceUrlOf(item: GoogleItem): string {
  const src = item.source;
  if (src && typeof src === 'object' && src.$?.url) return src.$?.url ?? '';
  if (typeof src === 'string' && /^https?:/.test(src)) return src;
  return '';
}

/**
 * rss-parser drops element attributes, so `<source url="…">` (the publisher
 * link Google News attaches to every item) is invisible to it. Split the raw
 * XML into item blocks and read the attribute directly, keeping the array
 * index-aligned with the parsed items.
 */
function sourceUrlsFromXml(xml: string): string[] {
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  return blocks.map((block) => {
    const body = block.split(/<\/item>/i)[0] ?? '';
    return body.match(/<source[^>]*url="([^"]+)"/i)?.[1] ?? '';
  });
}

/** Strip Google's " - Publisher Name" suffix from a headline. */
function cleanGoogleTitle(title: string): string {
  return title.replace(/\s+-\s+[^-]{2,40}$/, '').trim();
}

/**
 * Unwrap a Google News redirect into the publisher's article URL.
 * Returns null when the exchange fails (Google changes this often).
 */
export async function resolveGoogleNewsUrl(googleUrl: string): Promise<string | null> {
  const cached = resolveCache.get(googleUrl);
  if (cached !== undefined) return cached || null;

  const idMatch = googleUrl.match(/\/articles\/([^?/]+)/);
  if (!idMatch) return null;
  const articleId = idMatch[1];

  // Step 1: read the signed timestamp + signature from the interstitial page.
  const page = await fetchUrl(googleUrl, {
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    timeoutMs: 12000,
  });
  if (!page.ok || !page.body) return null;

  const ts = page.body.match(/data-n-a-ts="([^"]+)"/)?.[1];
  const sig = page.body.match(/data-n-a-sg="([^"]+)"/)?.[1];
  if (!ts || !sig) {
    logger.debug({ googleUrl: googleUrl.slice(0, 60) }, 'google news: no signature on page');
    return null;
  }

  // Step 2: exchange the signature for the publisher URL.
  const garturlreq = JSON.stringify([
    'garturlreq',
    [
      ['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
      'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
    ],
    articleId,
    ts,
    sig,
  ]);
  const payload = JSON.stringify([[['Fbv4je', garturlreq, null, 'generic']]]);

  try {
    const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'user-agent': config.userAgent,
      },
      body: new URLSearchParams({ 'f.req': payload }).toString(),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const text = await res.text();

    const escaped = text.match(/garturlres\\",\\"(https?:[^"\\]+)/);
    let resolved: string | null = null;
    if (escaped) {
      try {
        resolved = JSON.parse(`"${escaped[1]}"`);
      } catch {
        resolved = escaped[1];
      }
    }
    if (!resolved) {
      const candidates = (text.match(/https?:\/\/[^\\"]{15,400}/g) ?? []).filter(
        (u) => !u.includes('google.com') && !u.includes('gstatic.com'),
      );
      resolved = candidates[0] ?? null;
    }

    if (resolveCache.size > RESOLVE_CACHE_MAX) resolveCache.clear();
    resolveCache.set(googleUrl, resolved ?? '');
    return resolved;
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'google news resolve failed');
    return null;
  }
}

/**
 * Discover articles for a source through Google News `site:` queries.
 * Items whose publisher host does not match, or whose URL cannot be unwrapped,
 * are dropped rather than emitted with a misleading Google link.
 */
export async function discoverFromGoogleNews(
  source: SourceDef,
  opts: { maxResolve?: number } = {},
): Promise<DiscoverResult> {
  const started = Date.now();
  const cfg = source.googleNews;

  if (!cfg) {
    return {
      sourceId: source.id, items: [], ok: false, status: 0,
      error: 'no googleNews config', durationMs: 0, notModified: false,
    };
  }

  const now = new Date();
  const items: RawItem[] = [];
  const seen = new Set<string>();
  const maxResolve = opts.maxResolve ?? 12;
  let resolvedCount = 0;
  const errors: string[] = [];

  for (const query of cfg.queries) {
    const url =
      'https://news.google.com/rss/search?q=' +
      encodeURIComponent(`${query} when:${config.ingest.lookbackDays}d`) +
      '&hl=en-NG&gl=NG&ceid=NG:en';

    const res = await fetchUrl(url, {
      accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5',
    });
    if (!res.ok || !res.body) {
      errors.push(`${query}: ${res.error ?? `HTTP ${res.status}`}`);
      continue;
    }

    let feed: Awaited<ReturnType<typeof parser.parseString>>;
    try {
      feed = await parser.parseString(res.body);
    } catch (err) {
      errors.push(`${query}: parse failed`);
      continue;
    }

    const parsedItems = (feed.items ?? []) as GoogleItem[];
    const xmlSourceUrls = sourceUrlsFromXml(res.body);

    for (const [index, item] of parsedItems.entries()) {
      const link = item.link;
      const title = (item.title ?? '').replace(/\s+/g, ' ').trim();
      if (!link || !title) continue;

      // Publisher attribution: prefer the raw <source url>, fall back to any
      // attribute rss-parser preserved. A missing/unparseable value is not
      // fatal — the resolved article URL is checked again below.
      const publisherUrl = xmlSourceUrls[index] || sourceUrlOf(item);
      if (publisherUrl) {
        try {
          const host = new URL(publisherUrl).hostname;
          if (!hostMatches(host, cfg.expectedHost)) continue;
        } catch {
          /* unparseable attribution — defer to the resolved URL check */
        }
      }

      const date = parseDate(item.isoDate ?? item.pubDate ?? null);
      const publishedAt = date ? sanitizePublishedAt(date, now) : null;

      if (resolvedCount >= maxResolve) break;

      const resolved = await resolveGoogleNewsUrl(link);
      if (!resolved) continue;

      let host: string;
      try {
        host = new URL(resolved).hostname;
      } catch {
        continue;
      }
      if (!hostMatches(host, cfg.expectedHost)) continue;
      if (seen.has(resolved)) continue;

      seen.add(resolved);
      resolvedCount++;

      items.push({
        sourceId: source.id,
        url: resolved,
        title: cleanGoogleTitle(title),
        publishedAt,
        feedSummary: '',
        feedContent: '',
        feedCategories: [],
        enclosureImage: null,
        author: null,
      });
    }
  }

  logger.debug(
    { source: source.id, items: items.length, resolved: resolvedCount, ms: Date.now() - started },
    'google news discovery',
  );

  return {
    sourceId: source.id,
    items,
    ok: items.length > 0 || errors.length === 0,
    status: 200,
    error: errors.length ? errors.join(' | ').slice(0, 300) : undefined,
    durationMs: Date.now() - started,
    notModified: false,
  };
}

/**
 * Broad discovery across all Nigerian publishers via the topic queries in
 * `DISCOVERY_QUERIES`. Items are attributed to a registry source when the
 * publisher host is known, otherwise to a synthetic "discovery" source.
 */
export async function discoverTopicQueries(
  queries: Array<{ id: string; query: string }>,
  expectedHosts: Map<string, string>,
  opts: { maxResolve?: number } = {},
): Promise<RawItem[]> {
  const now = new Date();
  const items: RawItem[] = [];
  const seen = new Set<string>();
  const maxResolve = opts.maxResolve ?? 15;
  let resolved = 0;

  for (const q of queries) {
    if (resolved >= maxResolve) break;
    const url =
      'https://news.google.com/rss/search?q=' +
      encodeURIComponent(`${q.query} when:${config.ingest.lookbackDays}d`) +
      '&hl=en-NG&gl=NG&ceid=NG:en';

    const res = await fetchUrl(url, { accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5' });
    if (!res.ok || !res.body) continue;

    let feed: Awaited<ReturnType<typeof parser.parseString>>;
    try {
      feed = await parser.parseString(res.body);
    } catch {
      continue;
    }

    const parsedItems = (feed.items ?? []) as GoogleItem[];
    const xmlSourceUrls = sourceUrlsFromXml(res.body);

    for (const [index, item] of parsedItems.entries()) {
      if (resolved >= maxResolve) break;
      const link = item.link;
      const title = (item.title ?? '').replace(/\s+/g, ' ').trim();
      if (!link || !title) continue;

      const publisherUrl = xmlSourceUrls[index] || sourceUrlOf(item);
      let host = '';
      try {
        host = new URL(publisherUrl).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }

      const mapped = expectedHosts.get(host);
      if (!mapped) continue; // only attribute to known registry publishers

      const resolvedUrl = await resolveGoogleNewsUrl(link);
      if (!resolvedUrl || seen.has(resolvedUrl)) continue;

      seen.add(resolvedUrl);
      resolved++;

      const date = parseDate(item.isoDate ?? item.pubDate ?? null);
      items.push({
        sourceId: mapped,
        url: resolvedUrl,
        title: cleanGoogleTitle(title),
        publishedAt: date ? sanitizePublishedAt(date, now) : null,
        feedSummary: '',
        feedContent: '',
        feedCategories: [],
        enclosureImage: null,
        author: null,
      });
    }
  }

  return items;
}
