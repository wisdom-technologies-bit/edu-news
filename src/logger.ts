import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
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
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service,version' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
