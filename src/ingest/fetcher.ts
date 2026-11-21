import { config } from '../config.js';
import { logger } from '../logger.js';

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string;
  body: string;
  contentType: string;
  etag?: string;
  lastModified?: string;
  fromCache: boolean;
  attempts: number;
  error?: string;
  durationMs: number;
}

export interface FetchOptions {
  /** Conditional-GET validators from a previous fetch. */
  etag?: string;
  lastModified?: string;
  /** Override the global timeout. */
  timeoutMs?: number;
  /** Accept header to advertise. */
  accept?: string;
  /** Treat these status codes as success (default: 200-299). */
  allowStatus?: number[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-host serialisation so we never hammer a publisher. */
const hostQueues = new Map<string, Promise<void>>();
const hostLastHit = new Map<string, number>();

async function respectHostDelay(host: string): Promise<void> {
  const delay = config.ingest.perHostDelayMs;
  if (delay <= 0) return;
  const previous = hostQueues.get(host) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  hostQueues.set(host, previous.then(() => gate));
  await previous;
  const last = hostLastHit.get(host) ?? 0;
  const wait = last + delay - Date.now();
  if (wait > 0) await sleep(wait);
  hostLastHit.set(host, Date.now());
  release();
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * Fetch a URL with retries, per-host politeness and conditional-GET support.
 * Never throws: transport failures come back as `ok: false` with a reason.
 */
export async function fetchUrl(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? config.ingest.timeoutMs;
  const maxAttempts = Math.max(1, config.ingest.retries + 1);
  const allowStatus = opts.allowStatus ?? [];

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return {
      ok: false, status: 0, url, body: '', contentType: '', fromCache: false,
      attempts: 0, error: 'invalid url', durationMs: 0,
    };
  }

  const headers: Record<string, string> = {
    'user-agent': config.userAgent,
    accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-NG,en-GB;q=0.9,en;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
  };
  if (opts.etag) headers['if-none-match'] = opts.etag;
  if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;

  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await respectHostDelay(host);
    try {
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });

      const contentType = res.headers.get('content-type') ?? '';
      const etag = res.headers.get('etag') ?? undefined;
      const lastModified = res.headers.get('last-modified') ?? undefined;

      if (res.status === 304) {
        return {
          ok: true, status: 304, url: res.url, body: '', contentType,
          etag, lastModified, fromCache: true, attempts: attempt, durationMs: Date.now() - started,
        };
      }

      if (res.ok || allowStatus.includes(res.status)) {
        const body = await res.text();
        return {
          ok: true, status: res.status, url: res.url, body, contentType,
          etag, lastModified, fromCache: false, attempts: attempt, durationMs: Date.now() - started,
        };
      }

      lastError = `HTTP ${res.status}`;
      if (!RETRYABLE_STATUS.has(res.status) || attempt === maxAttempts) {
        return {
          ok: false, status: res.status, url: res.url, body: '', contentType,
          etag, lastModified, fromCache: false, attempts: attempt,
          error: lastError, durationMs: Date.now() - started,
        };
      }
    } catch (err) {
      const e = err as Error;
      lastError = e.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : e.message;
      if (attempt === maxAttempts) {
        return {
          ok: false, status: 0, url, body: '', contentType: '',
          fromCache: false, attempts: attempt, error: lastError, durationMs: Date.now() - started,
        };
      }
    }

    // Exponential backoff with jitter before the next attempt.
    const backoff = Math.min(8000, 600 * 2 ** (attempt - 1)) + Math.random() * 400;
    logger.debug({ url, attempt, backoff, lastError }, 'retrying fetch');
    await sleep(backoff);
  }

  return {
    ok: false, status: 0, url, body: '', contentType: '',
    fromCache: false, attempts: maxAttempts, error: lastError, durationMs: Date.now() - started,
  };
}

/** Strip HTML tags and collapse whitespace — used for excerpts and scores. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trim text to a clean sentence-ish boundary. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const cut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (cut > max * 0.6) return slice.slice(0, cut + 1).trim();
  const space = slice.lastIndexOf(' ');
  return `${slice.slice(0, space > 0 ? space : max).trim()}…`;
}
