import pino from 'pino';
import { config } from './config.js';

/**
 * Logs always go to stderr so stdout is reserved for machine-readable output.
 * `npm run ingest -- --json` writes its report to stdout, and a single warning
 * written there would make the stream unparseable.
 */
export const logger = pino(
  {
    level: config.log.level,
    base: { service: 'edu-news', version: config.version },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-ingest-token"]', 'password', '*.password'],
      censor: '[redacted]',
    },
    ...(config.log.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname,service,version',
              destination: 2,
            },
          },
        }
      : {}),
  },
  config.log.pretty ? undefined : pino.destination(2),
);

export type Logger = typeof logger;
