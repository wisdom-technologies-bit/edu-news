import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // The integration tests run against the in-memory Redis implementation so
    // they need no external services. REDIS_URL must be set before `config`
    // is imported, which is why it lives here rather than in a setup file.
    env: {
      REDIS_URL: 'mock://',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      INGEST_ON_BOOT: 'false',
      INGEST_INTERVAL_MINUTES: '0',
      INGEST_TOKEN: 'test-token',
      RATE_LIMIT_PER_MINUTE: '10000',
      RESPONSE_CACHE_SECONDS: '0',
    },
  },
});
