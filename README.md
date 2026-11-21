# edu-news

A Nigerian education-news aggregation API. It collects the **last 10 days** of
tertiary-education news from Nigerian publishers, regulators and campus news
sites, extracts each article into clean **Markdown** (publisher formatting and
images preserved), caches everything in **Redis**, and serves it through a
single JSON endpoint.

Built for FUTO Central, but not tied to it: any client that wants Nigerian
education news can call it.

```
GET /api/news?limit=1
```

```json
{
  "meta": {
    "count": 1,
    "total": 46,
    "days": 10,
    "page": 1,
    "limit": 1,
    "offset": 0,
    "sort": "newest",
    "has_more": true,
    "generated_at": "2026-11-21T01:46:49.837Z",
    "window": { "from": "2026-11-11T01:46:49.837Z", "to": "2026-11-21T01:46:49.837Z" },
    "filters": { "sources": null, "categories": null, "institutions": null, "countries": null, "query": null, "verified_only": false }
  },
  "data": [
    {
      "id": "594e2c8054750e4e",
      "title": "FUHSO 25 Programme Options and Cut-Off Marks 2026",
      "excerpt": "FUHSO invites eligible 2026 UTME candidates awaiting admission to change programmes by 30 November. See all 25 programme options and minimum scores.",
      "content": "![Federal University of Health Sciences, Otukpo](https://myschoolgist.com/wp-content/uploads/2023/05/FUHSO.jpg)\n\nThe Federal University of Health Sciences, Otukpo (FUHSO), has invited candidates...\n\n## FUHSO programme options and minimum UTME scores\n\n| Programme | Minimum UTME score |\n| --- | --- |\n| B.RAD. Radiography | 230 |\n| D.PT. Physiotherapy | 230 |\n\n## How to change programme at FUHSO\n\n1. Choose a listed programme...",
      "source_name": "MySchoolGist",
      "source_url": "https://myschoolgist.com/news/fuhso-programme-change-admission-195603/",
      "image_url": "https://myschoolgist.com/wp-content/uploads/2023/05/FUHSO.jpg",
      "published_at": "2026-11-20T23:00:04Z",
      "category": "Admissions",
      "institution": "Federal University of Health Sciences Otukpo",
      "country": "Nigeria",
      "original_language": "en",
      "is_verified": true
    }
  ]
}
```

That response is real output from this service, abridged for readability.

---

## Quick start

### Docker (recommended)

```bash
git clone https://github.com/wisdom-technologies-bit/edu-news.git
cd edu-news
docker compose up -d --build
```

The API listens on `http://localhost:8080`. It ingests on boot and then every
30 minutes.

```bash
curl "http://localhost:8080/api/news?limit=3"
curl "http://localhost:8080/api/news?category=Admissions"
curl "http://localhost:8080/api/news?q=FUTO"
```

### Local development

Requires Node 20.11+ and a Redis server.

```bash
npm install
cp .env.example .env
npm run dev          # API with hot reload on :8080
npm run ingest       # one collection pass, printed as a table
npm test             # 114 unit + integration tests
```

**No Redis installed?** Run everything against an in-memory backend:

```bash
REDIS_URL=mock:// npm run ingest
REDIS_URL=mock:// npm run dev
```

Intended for development, CI and demos. Data does not persist and is not shared
between processes.

---

## How it works

```
  ┌─────────────┐   ┌──────────────┐   ┌───────────────┐   ┌──────────────┐
  │  Discovery  │ → │  Extraction  │ → │    Markdown   │ → │  Classify    │
  │ RSS · HTML  │   │  Readability │   │  HTML → MD    │   │ + relevance  │
  │ Google News │   │  or feed body│   │  + images     │   │ + institution│
  └─────────────┘   └──────────────┘   └───────────────┘   └──────────────┘
                                                                   │
                          ┌────────────────────────────────────────┘
                          ▼
                  ┌───────────────┐        ┌──────────────────┐
                  │     Redis     │  ────► │   Express API    │
                  │ TTL + dedupe  │        │  /api/news …     │
                  └───────────────┘        └──────────────────┘
```

1. **Discovery.** Each publisher declares how it is read: an RSS feed, a
   scraped listing page, or Google News. Sources are visited authority-first so
   the most authoritative version of a story wins any duplicate contest.
2. **Extraction.** If the feed carries a substantial body it is used directly
   (fast, and the publisher's own markup). Otherwise the article page is fetched
   and run through Mozilla Readability, which strips navigation, adverts and
   footers.
3. **Markdown.** HTML is converted with Turndown, preserving headings,
   emphasis, lists, blockquotes, tables, links and images. Lazy-loaded images
   (`data-src`, `srcset`) are resolved, tracking pixels dropped, relative URLs
   absolutised, and `<figcaption>` text kept as italics under the image.
4. **Classification.** Every article is scored for education relevance (which
   filters casino and affiliate spam out of campus feeds), then tagged with a
   category, an institution and a country.
5. **Storage.** Articles are written to Redis with a TTL, indexed by
   publication time, and deduplicated by canonical URL and normalised title
   fingerprint so the same story from two outlets is stored once.

### Why Redis

- **Short memory, fresh news.** Articles expire after `RETENTION_DAYS` (21 by
  default) and the index is trimmed to the collection window, so the API never
  drifts into stale archives.
- **No repeats.** The URL key and title fingerprint mean a story is stored once
  even when it appears in several feeds, and re-running ingestion is idempotent.
- **Cheap reads.** Assembled `/api/news` responses are cached for
  `RESPONSE_CACHE_SECONDS`, so traffic does not re-hydrate thousands of records.
- **Polite crawling.** Conditional-GET validators (`ETag`, `Last-Modified`) are
  stored per source, so an unchanged feed costs a `304` instead of a full
  download.

---

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/news` | Latest articles (default: last 10 days) |
| `GET` | `/api/news/:id` | A single article |
| `GET` | `/api/sources` | Source directory with live health |
| `GET` | `/api/facets` | Categories, institutions and sources in the window |
| `GET` | `/api/stats` | Counts, coverage and last ingestion summary |
| `GET` | `/api/health` | Liveness and Redis status |
| `POST` | `/api/ingest` | Force a collection pass (needs `x-ingest-token`) |

### `/api/news` query parameters

| Parameter | Default | Notes |
| --- | --- | --- |
| `days` | `10` | 1–30 |
| `limit` | `20` | 1–100 |
| `page` | `1` | Page number |
| `offset` | — | Raw offset, overrides `page` |
| `sort` | `newest` | `newest` · `oldest` · `relevance` |
| `source` | — | Source id, repeatable or comma-separated |
| `category` | — | e.g. `Admissions`, `Accreditation` |
| `institution` | — | Substring match, e.g. `FUTO` |
| `country` | — | e.g. `Nigeria` |
| `q` | — | Full-text search over title, excerpt, body and tags |
| `verified` | `false` | `true` to return only verified articles |

Full reference, including every field and error code: **[docs/API.md](docs/API.md)**.

---

## Source coverage

32 publishers are registered and 26 are active. Coverage was verified live
against each publisher's own endpoints; per-source findings are recorded in
**[docs/SOURCES.md](docs/SOURCES.md)**.

| Tier | Working now | Notes |
| --- | --- | --- |
| Official authorities | NUC, TETFund, Federal Ministry of Education | Feed or listing page |
| National newspapers | Punch, Vanguard, Premium Times, ThisDay, Daily Post, BusinessDay, Tribune, Channels TV | Feeds; Vanguard, ThisDay, Channels and Daily Post carry full bodies |
| Education specialists | MySchoolGist, MySchool.ng, Campus Info, Edugist, Current School News, Schoolings, Nigeria School News, FlashLearners, Studentship, Bscholarly, Martins Library, Scholarship Region, EduPodia | 13 of 13 working |
| Needs headless browser | The Guardian Nigeria, TheCable | Cloudflare JS challenge |
| Not collectable | JAMB, NBTE, NCCE | Publish PDFs and login-walled notices, not articles |
| Dead domains | Campus Portal, Educatinfo, Nigerian Scholars | DNS failure / HTTP 410 |

**24 of 26 active sources work with no extra setup.** The two remaining
(Guardian Nigeria, TheCable) sit behind a Cloudflare JavaScript challenge that
returns `403` to every plain HTTP client — feed, sitemap, robots and article
HTML alike. They are fully supported through an optional headless-Chromium
renderer:

```bash
npm i playwright
npx playwright install --with-deps chromium
ENABLE_BROWSER_RENDERER=true npm run dev
```

Discovery for those two runs through Google News (which still indexes them);
the renderer supplies the article body.

A live pass stores roughly **230 articles across 24 sources** in about 45
seconds.

---

## Configuration

Every setting has a safe default; see [`.env.example`](.env.example) for the
annotated list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | Redis connection; `mock://` for in-memory |
| `INGEST_LOOKBACK_DAYS` | `10` | How far back each run collects |
| `RETENTION_DAYS` | `21` | Article TTL in Redis |
| `INGEST_INTERVAL_MINUTES` | `30` | Scheduler period (`0` disables) |
| `INGEST_ON_BOOT` | `true` | Run a pass at startup |
| `FETCH_CONCURRENCY` | `8` | Parallel requests per pass |
| `PER_HOST_DELAY_MS` | `750` | Politeness delay per publisher |
| `INGEST_TOKEN` | — | Enables `POST /api/ingest` |
| `ENABLE_BROWSER_RENDERER` | `false` | Headless Chromium for Cloudflare sites |
| `CORS_ORIGINS` | `*` | Allowed browser origins |

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | API with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm test` | Unit and integration tests |
| `npm run typecheck` | Type-check without emitting |
| `npm run ingest` | One collection pass |
| `npm run --silent ingest -- --json` | Machine-readable report on stdout (`--silent` keeps npm's banner out) |
| `npm run ingest -- --discovery` | Also run the Google News topic queries |
| `npm run ingest -- --source=punch,edugist` | Restrict to specific sources |
| `npm run ingest:sources` | Probe every publisher and report what works |

---

## Deployment

Docker, a bare VPS with systemd, and managed platforms (Railway, Render,
Fly.io) are covered in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**, along with
managed Redis options, scheduled ingestion via cron, scaling notes and
monitoring.

---

## Documentation

- **[docs/API.md](docs/API.md)** — every endpoint, parameter, field and error
- **[docs/SOURCES.md](docs/SOURCES.md)** — per-publisher findings and how to add a source
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — deploy, scale and operate

---

## A note on publishers

This service reads publicly available feeds and article pages, at a polite rate,
for the purpose of indexing and attribution. Every article keeps its
`source_name` and a canonical `source_url` back to the publisher, and `excerpt`
is deliberately truncated so the API is a discovery layer rather than a
replacement for reading the original. Set `CONTACT_EMAIL` so publishers can
reach you, respect their `robots.txt` and terms, and link users back to the
source.

## License

MIT — see [LICENSE](LICENSE).
