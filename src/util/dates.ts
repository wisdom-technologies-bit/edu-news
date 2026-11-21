/** Date helpers. Everything the API emits is ISO-8601 UTC. */

export const DAY_MS = 86_400_000;

/** Parse many common feed date formats into a Date, or null. */
export function parseDate(input: unknown): Date | null {
  if (!input) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;

  const raw = String(input).trim();
  if (!raw) return null;

  // RFC-822 / RFC-2822 as used by RSS (e.g. "Fri, 20 Nov 2026 23:00:04 +0000")
  const native = new Date(raw);
  if (!Number.isNaN(native.getTime())) return native;

  // "2026-11-20 14:12:58" without a timezone → treat as UTC
  const isoNoTz = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (isoNoTz) {
    const [, y, mo, d, h, mi, s] = isoNoTz;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0)));
  }

  // "20 November 2026" / "20 Nov 2026"
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const long = raw.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
  if (long) {
    const monthIdx = monthNames.findIndex((m) => m.startsWith(long[2].toLowerCase()));
    if (monthIdx >= 0) return new Date(Date.UTC(+long[3], monthIdx, +long[1], 12, 0, 0));
  }

  // "Nov 20, 2026"
  const us = raw.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (us) {
    const monthIdx = monthNames.findIndex((m) => m.startsWith(us[1].toLowerCase()));
    if (monthIdx >= 0) return new Date(Date.UTC(+us[3], monthIdx, +us[2], 12, 0, 0));
  }

  return null;
}

/**
 * Some publishers omit the year or publish a future-dated placeholder.
 * Clamp anything absurd into a sane range so sorting stays truthful.
 */
export function sanitizePublishedAt(date: Date, now = new Date()): Date {
  const maxFuture = now.getTime() + DAY_MS; // allow 1 day of clock skew
  if (date.getTime() > maxFuture) return now;
  // Older than 2 years is almost certainly a parse artefact.
  if (date.getTime() < now.getTime() - 730 * DAY_MS) return now;
  return date;
}

export function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Midnight UTC `days` ago. */
export function daysAgo(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export function isWithinDays(d: Date, days: number, now = new Date()): boolean {
  const t = d.getTime();
  return t >= daysAgo(days, now).getTime() && t <= now.getTime() + DAY_MS;
}

/** Human relative time, used in the HTML index and logs. */
export function humanAgo(d: Date, now = new Date()): string {
  const mins = Math.round((now.getTime() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
