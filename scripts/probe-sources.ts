#!/usr/bin/env tsx
/**
 * Source health probe.
 *
 * Checks every registered publisher and prints a table of what actually works
 * right now: feed availability, item counts, whether the feed carries full
 * bodies, and whether article pages are extractable.
 *
 *   npm run ingest:sources            # probe everything
 *   npm run ingest:sources -- --json  # machine-readable
 *
 * Run this after adding a publisher, or when /api/sources shows failures.
 */
import { SOURCES } from '../src/sources/registry.js';
import { discoverFromFeed } from '../src/ingest/rss.js';
import { discoverFromHtmlList } from '../src/ingest/htmllist.js';
import { extractArticle } from '../src/ingest/extract.js';
import { stripHtml } from '../src/ingest/fetcher.js';
import { config } from '../src/config.js';

interface ProbeRow {
  id: string;
  name: string;
  discovery: string;
  active: boolean;
  ok: boolean;
  items: number;
  fullFeed: boolean;
  pageExtract: string;
  error?: string;
  ms: number;
}

async function probe(id: string): Promise<ProbeRow> {
  const source = SOURCES.find((s) => s.id === id);
  if (!source) throw new Error(`unknown source ${id}`);

  const started = Date.now();
  const row: ProbeRow = {
    id: source.id,
    name: source.name,
    discovery: source.discovery,
    active: !source.disabled,
    ok: false,
    items: 0,
    fullFeed: false,
    pageExtract: '—',
    ms: 0,
  };

  if (source.disabled) {
    row.error = source.disabledReason ?? 'disabled';
    row.ms = Date.now() - started;
    return row;
  }

  if (source.discovery === 'rss') {
    const result = await discoverFromFeed(source);
    row.ok = result.ok;
    row.items = result.items.length;
    row.error = result.error;
    const first = result.items[0];
    if (first) {
      const bodyChars = stripHtml(first.feedContent).length;
      row.fullFeed = bodyChars >= config.ingest.minFeedContentChars;
      if (!row.fullFeed && source.content !== 'feed') {
        const page = await extractArticle(first.url);
        row.pageExtract = page.ok
          ? `ok (${page.markdown.wordCount} words, ${page.markdown.images.length} img)`
          : `FAIL (${page.error ?? page.status})`;
      } else {
        row.pageExtract = row.fullFeed ? 'n/a (feed has body)' : 'n/a';
      }
    }
  } else if (source.discovery === 'html-list') {
    const result = await discoverFromHtmlList(source);
    row.ok = result.ok;
    row.items = result.items.length;
    row.error = result.error;
    const first = result.items[0];
    if (first) {
      const page = await extractArticle(first.url);
      row.pageExtract = page.ok
        ? `ok (${page.markdown.wordCount} words, ${page.markdown.images.length} img)`
        : `FAIL (${page.error ?? page.status})`;
    }
  } else {
    row.pageExtract = 'google-news (skipped: requires live resolution)';
    row.ok = true;
  }

  row.ms = Date.now() - started;
  return row;
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const only = process.argv.find((a) => a.startsWith('--source='))?.split('=')[1]?.split(',');
  const targets = only?.length ? only : SOURCES.map((s) => s.id);

  const rows: ProbeRow[] = [];
  const concurrency = 4;

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((id) => probe(id).catch((err) => ({
      id,
      name: id,
      discovery: '?',
      active: false,
      ok: false,
      items: 0,
      fullFeed: false,
      pageExtract: '—',
      error: (err as Error).message,
      ms: 0,
    } as ProbeRow))));
    rows.push(...results);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  const lines: string[] = [];
  lines.push('');
  lines.push('  SOURCE                MODE        ITEMS  FEED-BODY  PAGE-EXTRACT');
  lines.push('  ' + '─'.repeat(88));
  for (const r of rows) {
    const status = r.active ? '' : ' [inactive]';
    lines.push(
      '  ' +
        (r.id + status).padEnd(22) +
        r.discovery.padEnd(12) +
        String(r.items).padStart(5) +
        (r.fullFeed ? '  full     ' : '  excerpt  ') +
        r.pageExtract +
        (r.error && !r.ok ? `  ← ${r.error.slice(0, 40)}` : ''),
    );
  }
  const okCount = rows.filter((r) => r.ok).length;
  lines.push('');
  lines.push(`  ${okCount}/${rows.length} sources reachable`);
  lines.push('');
  console.log(lines.join('\n'));
}

void main();
