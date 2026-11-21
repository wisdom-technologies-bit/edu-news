import * as cheerio from 'cheerio';
import { logger } from '../logger.js';
import type { SourceDef } from '../sources/types.js';
import { parseDate, sanitizePublishedAt } from '../util/dates.js';
import { fetchUrl } from './fetcher.js';
import type { DiscoverResult, RawItem } from './types.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Infer a publication date from card text such as "18 Nov" or "Nov 20, 2026".
 * Listing pages rarely expose machine-readable dates, so this is a best-effort
 * parse with year inference: a month later than the current one means last year.
 */
export function inferDateFromText(text: string, now = new Date()): Date | null {
  const clean = text.replace(/\s+/g, ' ').trim();

  // "20 November 2026" / "20 Nov 2026"
  const dmy = clean.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (dmy) {
    const idx = MONTHS.indexOf(dmy[2].slice(0, 3).toLowerCase());
    if (idx >= 0) return new Date(Date.UTC(+dmy[3], idx, +dmy[1], 12, 0, 0));
  }

  // "Nov 20, 2026"
  const mdy = clean.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (mdy) {
    const idx = MONTHS.indexOf(mdy[1].slice(0, 3).toLowerCase());
    if (idx >= 0) return new Date(Date.UTC(+mdy[3], idx, +mdy[2], 12, 0, 0));
  }

  // "18 Nov" / "18 November" — infer the year.
  const dm = clean.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\b/);
  if (dm) {
    const idx = MONTHS.indexOf(dm[2].slice(0, 3).toLowerCase());
    if (idx >= 0) {
      let year = now.getUTCFullYear();
      if (idx > now.getUTCMonth()) year -= 1; // a future month must be last year
      return new Date(Date.UTC(year, idx, +dm[1], 12, 0, 0));
    }
  }

  // "Nov 18" — infer the year.
  const md = clean.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\b/);
  if (md) {
    const idx = MONTHS.indexOf(md[1].slice(0, 3).toLowerCase());
    if (idx >= 0) {
      let year = now.getUTCFullYear();
      if (idx > now.getUTCMonth()) year -= 1;
      return new Date(Date.UTC(year, idx, +md[2], 12, 0, 0));
    }
  }

  // Relative "2 days ago"
  const rel = clean.match(/\b(\d+)\s+(minute|hour|day|week)s?\s+ago\b/i);
  if (rel) {
    const n = Number.parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms = unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : unit === 'day' ? 86_400_000 : 604_800_000;
    return new Date(now.getTime() - n * ms);
  }

  return null;
}

/** Strip the trailing date/comment noise a listing card appends to a title. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{0,4}\b.*$/i, '')
    .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s*\d{0,4}\b.*$/i, '')
    .replace(/\b\d+\s+Comments?\b.*$/i, '')
    .replace(/\s*\|\s*$/, '')
    .trim();
}

/**
 * Discover articles by scraping a server-rendered listing page.
 * Used for publishers with no usable feed (MySchool.ng, TETFund).
 */
export async function discoverFromHtmlList(source: SourceDef): Promise<DiscoverResult> {
  const started = Date.now();
  const cfg = source.htmlList;

  if (!cfg) {
    return {
      sourceId: source.id, items: [], ok: false, status: 0,
      error: 'no htmlList config', durationMs: 0, notModified: false,
    };
  }

  const res = await fetchUrl(cfg.url, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' });
  if (!res.ok || !res.body) {
    return {
      sourceId: source.id, items: [], ok: false, status: res.status,
      error: res.error ?? `HTTP ${res.status}`,
      durationMs: Date.now() - started, notModified: false,
    };
  }

  const $ = cheerio.load(res.body);
  const base = res.url || cfg.url;
  const now = new Date();
  const pattern = cfg.linkPattern ? new RegExp(cfg.linkPattern) : null;
  const seen = new Set<string>();
  const items: RawItem[] = [];

  const nodes = $(cfg.itemSelector);

  nodes.each((_, el) => {
    const node = $(el);
    const linkEl = cfg.linkSelector ? node.find(cfg.linkSelector).first() : node;
    const href = linkEl.attr('href') ?? node.attr('href');
    if (!href) return;

    let absolute: string;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      return;
    }

    if (pattern && !pattern.test(new URL(absolute).pathname)) return;
    if (seen.has(absolute)) return;

    const titleSource = cfg.titleSelector ? node.find(cfg.titleSelector).first().text() : linkEl.text();
    const title = cleanTitle(titleSource || '');
    if (title.length < 15) return; // navigation / "Read more" links

    seen.add(absolute);

    // Look for a date in the card, then in the nearest container.
    const cardText = node.text();
    const containerText = node.closest('article, li, div, tr').text().slice(0, 400);
    const dateText = cfg.dateSelector ? node.find(cfg.dateSelector).first().text() : '';
    const parsed =
      parseDate(dateText) ??
      inferDateFromText(dateText, now) ??
      inferDateFromText(cardText, now) ??
      inferDateFromText(containerText, now);

    items.push({
      sourceId: source.id,
      url: absolute,
      title,
      publishedAt: parsed ? sanitizePublishedAt(parsed, now) : null,
      feedSummary: '',
      feedContent: '',
      feedCategories: [],
      enclosureImage: null,
      author: null,
    });
  });

  logger.debug({ source: source.id, items: items.length, ms: Date.now() - started }, 'listing scraped');

  return {
    sourceId: source.id,
    items,
    ok: true,
    status: res.status,
    durationMs: Date.now() - started,
    notModified: false,
  };
}
