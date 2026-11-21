import { createApp } from './app.js';
import { assertConfig, config } from './config.js';
import { logger } from './logger.js';
import { closeRedis, getRedis, pingRedis } from './store/redis.js';
import { runIngestion } from './ingest/pipeline.js';

async function main(): Promise<void> {
  assertConfig();

  const redisStatus = await pingRedis();
  if (!redisStatus.ok) {
    logger.error(
      { error: redisStatus.error },
      'cannot reach Redis — the API needs Redis for storage. Start Redis or set REDIS_URL.',
    );
    process.exitCode = 1;
    return;
  }
  logger.info({ latencyMs: redisStatus.latencyMs }, 'redis reachable');
  getRedis();

  const app = createApp();
  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info(
      { port: config.server.port, host: config.server.host, env: config.env },
      `edu-news listening on http://${config.server.host}:${config.server.port}`,
    );
  });

  // ── Ingestion scheduler ─────────────────────────────────────────────────
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async (reason: string) => {
    if (running) {
      logger.debug({ reason }, 'ingestion tick skipped (already running)');
      return;
    }
    running = true;
    try {
      await runIngestion();
    } catch (err) {
      logger.error({ err: (err as Error).message, reason }, 'scheduled ingestion failed');
    } finally {
      running = false;
    }
  };

  if (config.ingest.onBoot) {
    // Do not block startup: the API serves whatever Redis already holds.
    setTimeout(() => void tick('boot'), 1500).unref();
  }

  if (config.ingest.intervalMinutes > 0) {
    const intervalMs = config.ingest.intervalMinutes * 60_000;
    timer = setInterval(() => void tick('interval'), intervalMs);
    timer.unref();
    logger.info({ everyMinutes: config.ingest.intervalMinutes }, 'ingestion scheduler started');
  } else {
    logger.info('internal scheduler disabled (INGEST_INTERVAL_MINUTES=0)');
  }

  // ── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    if (timer) clearInterval(timer);
    server.close();
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
    process.exit(1);
  });
}

void main();
