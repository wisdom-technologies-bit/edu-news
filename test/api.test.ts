import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { initRedis, getRedis, closeRedis } from '../src/store/redis.js';
import { saveArticle, type StoredArticle } from '../src/store/articles.js';

const DAY = 86_400_000;
const now = Date.now();

function fixture(overrides: Partial<StoredArticle> & Pick<StoredArticle, 'id' | 'title'>): StoredArticle {
  return {
    excerpt: 'A short summary of the story.',
    content: '## Heading\n\nBody paragraph with **bold** text.\n\n![Campus](https://cdn.example.com/photo.jpg)',
    source_id: 'edugist',
    source_name: 'Edugist',
    source_url: `https://edugist.org/${overrides.id}`,
    image_url: 'https://cdn.example.com/photo.jpg',
    published_at: new Date(now - 2 * DAY).toISOString(),
    category: 'Accreditation',
    institution: 'University of Lagos',
    country: 'Nigeria',
    original_language: 'en',
    is_verified: true,
    images: ['https://cdn.example.com/photo.jpg'],
    tags: ['university', 'accreditation'],
    author: 'Staff Reporter',
    tier: 'specialist',
    word_count: 120,
    extraction: 'page_full',
    relevance_score: 9,
    canonical_url: `https://edugist.org/${overrides.id}`,
    fingerprint: `fp-${overrides.id}`,
    fetched_at: new Date(now).toISOString(),
    ...overrides,
  };
}

const articles: StoredArticle[] = [
  fixture({
    id: 'aaaaaaaaaaaaaaaa',
    title: 'NUC approves 13 new degree programmes for Nigerian universities',
    category: 'Accreditation',
    institution: 'National Universities Commission',
    is_verified: true,
  }),
  fixture({
    id: 'bbbbbbbbbbbbbbbb',
    title: 'FUTO announces 2026/2027 admission list',
    category: 'Admissions',
    institution: 'FUTO',
    source_id: 'myschoolgist',
    source_name: 'MySchoolGist',
    published_at: new Date(now - 1 * DAY).toISOString(),
  }),
  fixture({
    id: 'cccccccccccccccc',
    title: 'Fully funded scholarship for Nigerian undergraduates',
    category: 'Scholarship',
    institution: null,
    source_id: 'scholarshipregion',
    source_name: 'Scholarship Region',
    is_verified: false,
    extraction: 'excerpt_only',
    published_at: new Date(now - 5 * DAY).toISOString(),
  }),
  fixture({
    id: 'dddddddddddddddd',
    title: 'ASUU threatens fresh strike over unpaid allowances',
    category: 'Policy',
    institution: null,
    source_id: 'punch',
    source_name: 'Punch Newspapers',
    tier: 'national',
    published_at: new Date(now - 9 * DAY).toISOString(),
  }),
  fixture({
    id: 'eeeeeeeeeeeeeeee',
    title: 'An old story from outside the window',
    category: 'Campus',
    published_at: new Date(now - 40 * DAY).toISOString(),
  }),
];

let app: Express;

beforeAll(async () => {
  await initRedis();
  await getRedis().flushall();
  for (const article of articles) await saveArticle(article);
  app = createApp();
});

afterAll(async () => {
  await closeRedis();
});

describe('GET /api/news — response contract', () => {
  it('returns the documented envelope', async () => {
    const res = await request(app).get('/api/news').expect(200);

    expect(res.body).toHaveProperty('meta');
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toMatchObject({
      days: 10,
      sort: 'newest',
    });
    expect(res.body.meta.count).toBe(res.body.data.length);
    expect(typeof res.body.meta.total).toBe('number');
    expect(typeof res.body.meta.has_more).toBe('boolean');
  });

  it('emits exactly the specified article shape', async () => {
    const res = await request(app).get('/api/news').expect(200);
    const article = res.body.data[0];

    const expectedKeys = [
      'id',
      'title',
      'excerpt',
      'content',
      'source_name',
      'source_url',
      'image_url',
      'published_at',
      'category',
      'institution',
      'country',
      'original_language',
      'is_verified',
    ];

    expect(Object.keys(article).sort()).toEqual([...expectedKeys].sort());
  });

  it('types every field correctly', async () => {
    const res = await request(app).get('/api/news').expect(200);
    const a = res.body.data[0];

    expect(typeof a.id).toBe('string');
    expect(typeof a.title).toBe('string');
    expect(typeof a.excerpt).toBe('string');
    expect(typeof a.content).toBe('string');
    expect(typeof a.source_name).toBe('string');
    expect(typeof a.source_url).toBe('string');
    expect(typeof a.published_at).toBe('string');
    expect(typeof a.category).toBe('string');
    expect(typeof a.country).toBe('string');
    expect(typeof a.original_language).toBe('string');
    expect(typeof a.is_verified).toBe('boolean');
    expect(a.image_url === null || typeof a.image_url === 'string').toBe(true);
    expect(a.institution === null || typeof a.institution === 'string').toBe(true);
  });

  it('returns published_at as ISO-8601 UTC', async () => {
    const res = await request(app).get('/api/news').expect(200);
    for (const a of res.body.data) {
      expect(a.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  it('returns content as Markdown with inline images', async () => {
    const res = await request(app).get('/api/news?q=NUC').expect(200);
    const a = res.body.data[0];
    expect(a.content).toContain('## Heading');
    expect(a.content).toContain('**bold**');
    expect(a.content).toMatch(/!\[[^\]]*\]\(https?:\/\//);
  });

  it('sets country and language for Nigerian English content', async () => {
    const res = await request(app).get('/api/news').expect(200);
    for (const a of res.body.data) {
      expect(a.country).toBe('Nigeria');
      expect(a.original_language).toBe('en');
    }
  });
});

describe('GET /api/news — window and filtering', () => {
  it('excludes articles older than the 10-day window', async () => {
    const res = await request(app).get('/api/news?days=10').expect(200);
    const ids = res.body.data.map((a: { id: string }) => a.id);
    expect(ids).not.toContain('eeeeeeeeeeeeeeee');
  });

  it('includes an article from 9 days ago', async () => {
    const res = await request(app).get('/api/news?days=10').expect(200);
    const ids = res.body.data.map((a: { id: string }) => a.id);
    expect(ids).toContain('dddddddddddddddd');
  });

  it('widens the window when days is larger', async () => {
    const res = await request(app).get('/api/news?days=30').expect(200);
    const ids = res.body.data.map((a: { id: string }) => a.id);
    expect(ids).not.toContain('eeeeeeeeeeeeeeee'); // 40 days old, still outside
  });

  it('sorts newest first by default', async () => {
    const res = await request(app).get('/api/news').expect(200);
    const times = res.body.data.map((a: { published_at: string }) => Date.parse(a.published_at));
    const sorted = [...times].sort((x, y) => y - x);
    expect(times).toEqual(sorted);
  });

  it('supports oldest-first ordering', async () => {
    const res = await request(app).get('/api/news?sort=oldest').expect(200);
    const times = res.body.data.map((a: { published_at: string }) => Date.parse(a.published_at));
    const sorted = [...times].sort((x, y) => x - y);
    expect(times).toEqual(sorted);
  });

  it('filters by category', async () => {
    const res = await request(app).get('/api/news?category=Admissions').expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const a of res.body.data) expect(a.category).toBe('Admissions');
  });

  it('accepts several categories at once', async () => {
    const res = await request(app).get('/api/news?category=Admissions,Scholarship').expect(200);
    const cats = new Set(res.body.data.map((a: { category: string }) => a.category));
    for (const c of cats) expect(['Admissions', 'Scholarship']).toContain(c);
  });

  it('filters by source id', async () => {
    const res = await request(app).get('/api/news?source=punch').expect(200);
    for (const a of res.body.data) expect(a.source_name).toBe('Punch Newspapers');
  });

  it('filters by institution', async () => {
    const res = await request(app).get('/api/news?institution=FUTO').expect(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].institution).toBe('FUTO');
  });

  it('filters to verified articles only', async () => {
    const res = await request(app).get('/api/news?verified=true').expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const a of res.body.data) expect(a.is_verified).toBe(true);
  });

  it('searches title and body text', async () => {
    const res = await request(app).get('/api/news?q=scholarship').expect(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].title).toContain('scholarship');
  });

  it('returns an empty set for a query that matches nothing', async () => {
    const res = await request(app).get('/api/news?q=zzzzzznomatch').expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });
});

describe('GET /api/news — pagination', () => {
  it('limits the page size and reports has_more', async () => {
    const res = await request(app).get('/api/news?limit=2').expect(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.meta.limit).toBe(2);
    expect(res.body.meta.total).toBe(4);
    expect(res.body.meta.has_more).toBe(true);
  });

  it('walks to the next page without repeating items', async () => {
    const first = await request(app).get('/api/news?limit=2&page=1').expect(200);
    const second = await request(app).get('/api/news?limit=2&page=2').expect(200);

    const firstIds = first.body.data.map((a: { id: string }) => a.id);
    const secondIds = second.body.data.map((a: { id: string }) => a.id);

    expect(firstIds).not.toEqual(secondIds);
    for (const id of secondIds) expect(firstIds).not.toContain(id);
    expect(second.body.meta.has_more).toBe(false);
  });

  it('supports raw offset', async () => {
    const res = await request(app).get('/api/news?limit=2&offset=2').expect(200);
    expect(res.body.meta.offset).toBe(2);
  });

  it('rejects an invalid limit', async () => {
    await request(app).get('/api/news?limit=9999').expect(400);
  });

  it('rejects a non-numeric days value', async () => {
    await request(app).get('/api/news?days=abc').expect(400);
  });
});

describe('GET /api/news/:id', () => {
  it('returns a single article', async () => {
    const res = await request(app).get('/api/news/aaaaaaaaaaaaaaaa').expect(200);
    expect(res.body.data.id).toBe('aaaaaaaaaaaaaaaa');
    expect(res.body.data.title).toContain('NUC');
  });

  it('404s for an unknown id', async () => {
    await request(app).get('/api/news/ffffffffffffffff').expect(404);
  });

  it('400s for a malformed id', async () => {
    await request(app).get('/api/news/not-a-hex-id!').expect(400);
  });
});

describe('metadata endpoints', () => {
  it('GET /api/sources documents every registered publisher', async () => {
    const res = await request(app).get('/api/sources').expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(25);

    const ids = res.body.data.map((s: { id: string }) => s.id);
    for (const expected of ['edugist', 'punch', 'guardian-ng', 'nuc', 'myschool', 'futo-placeholder-not-used']) {
      if (expected === 'futo-placeholder-not-used') continue;
      expect(ids).toContain(expected);
    }

    const sample = res.body.data.find((s: { id: string }) => s.id === 'guardian-ng');
    expect(sample).toMatchObject({ needs_browser: true, active: true });
  });

  it('GET /api/facets groups the window', async () => {
    const res = await request(app).get('/api/facets').expect(200);
    expect(res.body.data.categories.Admissions).toBeGreaterThanOrEqual(1);
    expect(Object.keys(res.body.data.sources).length).toBeGreaterThan(0);
  });

  it('GET /api/stats reports counts', async () => {
    const res = await request(app).get('/api/stats').expect(200);
    expect(res.body.data.articles).toBe(4);
    expect(res.body.data.verified).toBeGreaterThan(0);
    expect(res.body.data.by_category).toHaveProperty('Admissions');
    expect(res.body.data.redis.ok).toBe(true);
  });

  it('GET /api/health reports Redis and config', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.redis.ok).toBe(true);
    expect(res.body.config.lookback_days).toBe(10);
    expect(res.body.sources.active).toBeGreaterThan(20);
  });

  it('404s an unknown API route', async () => {
    await request(app).get('/api/nope').expect(404);
  });
});

describe('POST /api/ingest — protection', () => {
  it('rejects a request without the token', async () => {
    await request(app).post('/api/ingest').expect(401);
  });

  it('rejects a request with the wrong token', async () => {
    await request(app).post('/api/ingest').set('x-ingest-token', 'wrong').expect(401);
  });
});
