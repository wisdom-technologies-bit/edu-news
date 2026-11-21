#!/usr/bin/env tsx
/**
 * One-shot ingestion CLI.
 *
 *   npm run ingest                # collect from all active sources
 *   npm run ingest -- --discovery # also run the Google News topic queries
 *   npm run ingest -- --json      # machine-readable report on stdout
 *   npm run ingest -- --source punch,edugist
 *
 * Exits 0 when at least one source succeeded, 1 otherwise — suitable for cron.
 */
import { assertConfig, config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { closeRedis, initRedis } from '../src/store/redis.js';
import { runIngestion } from '../src/ingest/pipeline.js';
import { ACTIVE_SOURCES } from '../src/sources/registry.js';

function parseArgs(argv: string[]): { discovery: boolean; json: boolean; sources?: string[] } {
  const out = { discovery: false, json: false, sources: undefined as string[] | undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--discovery') out.discovery = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--source' || arg === '--sources') {
      out.sources = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--source=')) {
      out.sources = arg.slice('--source='.length).split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

async function main(): Promise<void> {
  assertConfig();
  await initRedis();
  const args = parseArgs(process.argv.slice(2));

  if (args.sources?.length) {
    const known = new Set(ACTIVE_SOURCES.map((s) => s.id));
    const unknown = args.sources.filter((s) => !known.has(s));
    if (unknown.length) {
      console.error(`Unknown or inactive source(s): ${unknown.join(', ')}`);
      console.error(`Available: ${[...known].join(', ')}`);
      process.exit(2);
    }
    // Restrict the pass by temporarily filtering the registry view.
    process.env.INGEST_ONLY_SOURCES = args.sources.join(',');
  }

  const report = await runIngestion({ includeDiscovery: args.discovery });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines: string[] = [];
    lines.push('');
    lines.push(`  Ingestion finished in ${(report.duration_ms / 1000).toFixed(1)}s`);
    lines.push(`  ${report.sources_ok}/${report.sources_total} sources OK · ${report.stored} new articles stored`);
    lines.push(
      `  ${report.discovered} discovered · ${report.stored} stored · ${report.skipped_out_of_window} outside window · ` +
        `${report.skipped_duplicate} duplicates · ${report.skipped_irrelevant} off-topic · ${report.failed_extractions} failed`,
    );
    lines.push('');
    lines.push('  SOURCE                DISC  NEW  OLD  DUP  IRREL  FAIL  STATUS');
    lines.push('  ' + '─'.repeat(64));
    for (const r of report.reports.sort((a, b) => b.new_articles - a.new_articles)) {
      const status = r.ok ? 'ok' : `FAIL${r.error ? `: ${r.error.slice(0, 34)}` : ''}`;
      lines.push(
        '  ' +
          r.source_id.padEnd(20) +
          String(r.discovered).padStart(5) +
          String(r.new_articles).padStart(5) +
          String(r.skipped_out_of_window ?? 0).padStart(5) +
          String(r.skipped_duplicate).padStart(5) +
          String(r.skipped_irrelevant).padStart(7) +
          String(r.failed_extractions).padStart(6) +
          '  ' + status,
      );
    }
    lines.push('');
    console.log(lines.join('\n'));
  }

  await closeRedis();

  const anyOk = report.sources_ok > 0;
  if (!anyOk) {
    logger.error('no source succeeded');
    process.exit(1);
  }
}

main().catch(async (err) => {
  logger.fatal({ err: (err as Error).message, stack: (err as Error).stack }, 'ingest CLI failed');
  await closeRedis().catch(() => undefined);
  process.exit(1);
});
