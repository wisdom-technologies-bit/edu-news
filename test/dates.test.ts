import { describe, it, expect } from 'vitest';
import { parseDate, sanitizePublishedAt, isWithinDays, daysAgo, iso } from '../src/util/dates.js';
import { inferDateFromText } from '../src/ingest/htmllist.js';

describe('parseDate', () => {
  it('parses RFC-822 feed dates', () => {
    const d = parseDate('Fri, 20 Nov 2026 23:00:04 +0000');
    expect(d?.toISOString()).toBe('2026-11-20T23:00:04.000Z');
  });

  it('parses ISO 8601', () => {
    expect(parseDate('2026-11-21T08:00:00Z')?.toISOString()).toBe('2026-11-21T08:00:00.000Z');
  });

  it('parses ISO without a timezone as UTC', () => {
    expect(parseDate('2026-11-20 14:12:58')?.toISOString()).toBe('2026-11-20T14:12:58.000Z');
  });

  it('parses long-form dates', () => {
    expect(parseDate('20 November 2026')?.toISOString().slice(0, 10)).toBe('2026-11-20');
  });

  it('parses US-style dates', () => {
    expect(parseDate('Nov 20, 2026')?.toISOString().slice(0, 10)).toBe('2026-11-20');
  });

  it('returns null for empty or junk input', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate('yesterday-ish')).toBeNull();
  });
});

describe('sanitizePublishedAt', () => {
  const now = new Date('2026-11-21T00:00:00Z');

  it('clamps far-future dates to now', () => {
    const future = new Date('2027-06-01T00:00:00Z');
    expect(sanitizePublishedAt(future, now).getTime()).toBe(now.getTime());
  });

  it('clamps implausibly old dates to now', () => {
    const ancient = new Date('2019-01-01T00:00:00Z');
    expect(sanitizePublishedAt(ancient, now).getTime()).toBe(now.getTime());
  });

  it('keeps a date inside the sane range', () => {
    const recent = new Date('2026-11-15T00:00:00Z');
    expect(sanitizePublishedAt(recent, now).getTime()).toBe(recent.getTime());
  });
});

describe('isWithinDays', () => {
  const now = new Date('2026-11-21T00:00:00Z');

  it('accepts an article from 3 days ago in a 10-day window', () => {
    expect(isWithinDays(new Date('2026-11-18T00:00:00Z'), 10, now)).toBe(true);
  });

  it('rejects an article from 11 days ago in a 10-day window', () => {
    expect(isWithinDays(new Date('2026-11-10T00:00:00Z'), 10, now)).toBe(false);
  });

  it('rejects an article older than the window', () => {
    expect(isWithinDays(new Date('2026-10-01T00:00:00Z'), 10, now)).toBe(false);
  });
});

describe('daysAgo / iso', () => {
  it('subtracts whole days', () => {
    const now = new Date('2026-11-21T00:00:00Z');
    expect(daysAgo(10, now).toISOString()).toBe('2026-11-11T00:00:00.000Z');
  });

  it('emits second-precision ISO strings', () => {
    expect(iso(new Date('2026-11-21T08:00:00.000Z'))).toBe('2026-11-21T08:00:00Z');
  });
});

describe('inferDateFromText', () => {
  const now = new Date('2026-11-21T00:00:00Z');

  it('reads a day-month with no year as the current year', () => {
    expect(inferDateFromText('18 Nov', now)?.toISOString().slice(0, 10)).toBe('2026-11-18');
  });

  it('reads a day-month-year', () => {
    expect(inferDateFromText('20 November 2026', now)?.toISOString().slice(0, 10)).toBe('2026-11-20');
  });

  it('reads a month-day-year', () => {
    expect(inferDateFromText('Nov 20, 2026', now)?.toISOString().slice(0, 10)).toBe('2026-11-20');
  });

  it('infers last year for a month that has not arrived yet', () => {
    // December is still ahead of November 21, so "3 Dec" must mean 2025.
    expect(inferDateFromText('3 Dec', now)?.toISOString().slice(0, 4)).toBe('2025');
  });

  it('reads a relative age', () => {
    expect(inferDateFromText('2 days ago', now)?.toISOString().slice(0, 10)).toBe('2026-11-19');
  });

  it('returns null when there is no date', () => {
    expect(inferDateFromText('no date here', now)).toBeNull();
  });
});
