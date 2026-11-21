# API reference

Base URL: `http://localhost:8080` in development, or your deployed host.

All responses are JSON. All timestamps are ISO-8601 UTC with second precision
(`2026-11-20T23:00:04Z`).

---

## Contents

- [`GET /api/news`](#get-apinews)
- [`GET /api/news/:id`](#get-apinewsid)
- [`GET /api/sources`](#get-apisources)
- [`GET /api/facets`](#get-apifacets)
- [`GET /api/stats`](#get-apistats)
- [`GET /api/health`](#get-apihealth)
- [`POST /api/ingest`](#post-apiingest)
- [The article object](#the-article-object)
- [Categories](#categories)
- [Errors](#errors)
- [Rate limiting and caching](#rate-limiting-and-caching)

---

## `GET /api/news`

Returns articles published within the requested window, newest first.

### Query parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `days` | integer 1–30 | `10` | Size of the publication window, ending now |
| `limit` | integer 1–100 | `20` | Articles per page |
| `page` | integer ≥ 1 | `1` | 1-indexed page number |
| `offset` | integer ≥ 0 | — | Raw offset into the result set; overrides `page` |
| `sort` | enum | `newest` | `newest`, `oldest` or `relevance` |
| `source` | string | — | Source id(s). Repeatable or comma-separated |
| `category` | string | — | Category name(s). Repeatable or comma-separated |
| `institution` | string | — | Institution substring, case-insensitive |
| `country` | string | — | Country name(s). Repeatable or comma-separated |
| `q` | string | — | Full-text search over title, excerpt, content, institution and tags |
| `verified` | boolean | `false` | `true` returns only articles with `is_verified: true` |

`source` and `sources`, `category` and `categories` are accepted as aliases.

`relevance` sorts by the classifier's education-relevance score, then by
publication time.

### Example

```bash
curl "http://localhost:8080/api/news?days=10&limit=2&category=Admissions&verified=true"
```

### Response

```json
{
  "meta": {
    "count": 2,
    "total": 12,
    "days": 10,
    "page": 1,
    "limit": 2,
    "offset": 0,
    "sort": "newest",
    "has_more": true,
    "generated_at": "2026-11-21T01:46:49.837Z",
    "window": {
      "from": "2026-11-11T01:46:49.837Z",
      "to": "2026-11-21T01:46:49.837Z"
    },
    "filters": {
      "sources": null,
      "categories": ["Admissions"],
      "institutions": null,
      "countries": null,
      "query": null,
      "verified_only": true
    }
  },
  "data": [ { "...": "article objects" } ]
}
```

| Meta field | Meaning |
| --- | --- |
| `count` | Articles in this page |
| `total` | Articles matching the filters across the whole window |
| `days` | Window size actually used |
| `page` / `limit` / `offset` | Pagination as applied |
| `sort` | Sort order actually used |
| `has_more` | `true` when `offset + count < total` |
| `window.from` / `window.to` | The exact publication range covered |
| `filters` | Echo of the applied filters (`null` when unset) |

---

## `GET /api/news/:id`

Returns one article by id. Ids are 16-character hex strings derived from the
canonical URL, so they are stable across restarts and ingestion passes.

```bash
curl "http://localhost:8080/api/news/594e2c8054750e4e"
```

```json
{ "data": { "...": "article object" } }
```

| Status | When |
| --- | --- |
| `200` | Article found |
| `400` | Id is not a hex string |
| `404` | Unknown id, or the article has expired from the cache |

---

## `GET /api/sources`

The publisher directory plus live health for each source.

```json
{
  "meta": {
    "total": 32,
    "active": 26,
    "healthy": 24,
    "generated_at": "2026-11-21T01:46:49.837Z"
  },
  "data": [
    {
      "id": "guardian-ng",
      "name": "The Guardian Nigeria",
      "homepage": "https://guardian.ng",
      "tier": "national",
      "discovery": "google-news",
      "content_strategy": "page",
      "category": "Education",
      "country": "Nigeria",
      "language": "en",
      "institution": null,
      "needs_browser": true,
      "active": true,
      "disabled_reason": null,
      "notes": "Cloudflare JS challenge: /feed/, sitemaps, robots and article HTML all return 403...",
      "health": {
        "last_run": "2026-11-21T01:42:12Z",
        "last_ok": "2026-11-21T01:42:12Z",
        "last_error": null,
        "consecutive_failures": 0,
        "last_discovered": 12,
        "last_stored": 12
      }
    }
  ]
}
```

`health` is `null` until the source has been attempted at least once.

| Field | Meaning |
| --- | --- |
| `tier` | `authority`, `national` or `specialist` — also the collection priority |
| `discovery` | `rss`, `html-list` or `google-news` |
| `content_strategy` | `feed`, `page`, `auto` or `excerpt` |
| `needs_browser` | Requires `ENABLE_BROWSER_RENDERER=true` |
| `active` | `false` for known-dead or non-article sources |
| `disabled_reason` | Why an inactive source is off |

---

## `GET /api/facets`

Counts of what is in the window, for building filter UIs.

```bash
curl "http://localhost:8080/api/facets?days=10"
```

```json
{
  "meta": { "days": 10, "generated_at": "2026-11-21T01:46:49.837Z" },
  "data": {
    "categories": { "Admissions": 12, "Campus": 15, "Accreditation": 3 },
    "institutions": { "FUTO": 4, "University of Lagos": 2 },
    "sources": { "myschoolgist": 25, "edugist": 10 }
  }
}
```

---

## `GET /api/stats`

Coverage and freshness at a glance.

```json
{
  "data": {
    "window_days": 10,
    "articles": 46,
    "verified": 46,
    "with_images": 27,
    "full_content": 46,
    "by_source": { "myschoolgist": 25, "edugist": 10, "campusinfo": 10, "nuc": 1 },
    "by_category": { "Admissions": 12, "Campus": 15, "Accreditation": 3 },
    "newest_article": "2026-11-20T23:00:04Z",
    "oldest_article": "2026-11-18T18:26:26Z",
    "newest_age": "3h ago",
    "last_ingestion": {
      "finished_at": "2026-11-21T01:46:49Z",
      "duration_ms": 12075,
      "stored": 46,
      "discovered": 55,
      "sources_ok": 4,
      "sources_failed": 0
    },
    "redis": { "ok": true, "latency_ms": 1 }
  }
}
```

`full_content` counts articles whose body was extracted rather than truncated to
an excerpt.

---

## `GET /api/health`

Liveness plus Redis status. Returns `200` when healthy and `503` when Redis is
unreachable — suitable for load-balancer and container health checks.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime_seconds": 512,
  "redis": { "ok": true, "latency_ms": 1, "error": null },
  "sources": { "total": 32, "active": 26 },
  "config": {
    "lookback_days": 10,
    "retention_days": 21,
    "ingest_interval_minutes": 30,
    "browser_renderer": false
  }
}
```

---

## `POST /api/ingest`

Forces a collection pass. Requires the `INGEST_TOKEN` environment variable to be
set; when it is not set the route returns `404`.

```bash
curl -X POST "http://localhost:8080/api/ingest" \
  -H "x-ingest-token: $INGEST_TOKEN"
```

Add `?discovery=true` to also run the broad Google News topic queries.

Returns the full ingestion report:

```json
{
  "data": {
    "started_at": "2026-11-21T01:42:00Z",
    "finished_at": "2026-11-21T01:42:42Z",
    "duration_ms": 42400,
    "sources_total": 26,
    "sources_ok": 24,
    "sources_failed": 2,
    "discovered": 499,
    "stored": 233,
    "skipped_duplicate": 0,
    "skipped_irrelevant": 100,
    "skipped_out_of_window": 155,
    "failed_extractions": 11,
    "pruned_index_entries": 0,
    "reports": [
      {
        "source_id": "myschool",
        "source_name": "MySchool.ng",
        "discovered": 107,
        "new_articles": 94,
        "skipped_duplicate": 0,
        "skipped_irrelevant": 2,
        "skipped_out_of_window": 0,
        "failed_extractions": 11,
        "ok": true,
        "duration_ms": 8210
      }
    ]
  }
}
```

Only one ingestion pass runs at a time: a Redis lock makes a concurrent request
return an empty report rather than doubling the crawl.

| Status | When |
| --- | --- |
| `200` | Pass completed |
| `401` | Missing or wrong `x-ingest-token` |
| `404` | `INGEST_TOKEN` is not configured |

---

## The article object

Every article, everywhere in the API, has exactly these thirteen fields.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | 16-char hex id, stable and derived from the canonical URL |
| `title` | string | Headline as published, without the trailing date/comment noise listing pages add |
| `excerpt` | string | Summary, at most 320 characters, plain text |
| `content` | string | Article body as **plain Markdown** |
| `source_name` | string | Publisher display name |
| `source_url` | string | Canonical article URL at the publisher |
| `image_url` | string \| null | Lead image: feed enclosure, page lead image, or first body image |
| `published_at` | string | ISO-8601 UTC, second precision |
| `category` | string | One of the categories below |
| `institution` | string \| null | Named institution, or the source's own institution for regulators |
| `country` | string | `Nigeria` for every current source |
| `original_language` | string | BCP-47 language tag, `en` for every current source |
| `is_verified` | boolean | See below |

### `content` format

Markdown, preserving the publisher's own structure:

```markdown
![Federal University of Health Sciences, Otukpo](https://myschoolgist.com/wp-content/uploads/2023/05/FUHSO.jpg)

The Federal University of Health Sciences, Otukpo (FUHSO), has invited candidates
who chose it as their first-choice institution in the 2026 UTME...

## FUHSO programme options and minimum UTME scores

| Programme | Minimum UTME score |
| --- | --- |
| B.RAD. Radiography | 230 |
| D.PT. Physiotherapy | 230 |

## How to change programme at FUHSO

1. Choose a listed programme for which the stipulated admission requirement is met.
2. Visit the university portal before the deadline.
```

What is preserved:

- headings, bold, italic, blockquotes, ordered and unordered lists
- **tables** (GitHub-flavoured Markdown)
- **images** as `![alt](absolute-url)`, including lazy-loaded `data-src` and
  the largest `srcset` candidate
- `<figcaption>` text as italics directly under its image
- links, resolved to absolute URLs; `javascript:` hrefs are unwrapped to text

What is removed:

- scripts, styles, inline event handlers
- navigation, sidebars, footers, comment sections
- share widgets, newsletter boxes, related-post blocks
- tracking pixels and 1×1 images
- unresolvable relative image paths
- adjacent duplicate copies of the same image (WordPress often emits the
  featured image twice)

### `is_verified`

`is_verified` means the body was retrieved in full and is a genuine article, not
that the publisher's claims were fact-checked. It is `true` when all of these
hold:

- the article is inside the collection window;
- the extracted body is at least `MIN_CONTENT_CHARS_FOR_VERIFY` characters of
  real text (default 400);
- the body was extracted from the article page or came in full via the feed —
  **or** the source is an official authority publishing a short notice.

An article truncated to an excerpt (a feed that carries only a summary, with the
page unreachable) is `false`.

---

## Categories

| Category | Typical content |
| --- | --- |
| `Admissions` | Admission lists, post-UTME forms, cut-off marks, change of course |
| `Examinations` | UTME/WAEC/NECO results, CBT, malpractice, grading |
| `Accreditation` | NUC/NBTE/NCCE approvals, programme accreditation, resource verification |
| `Scholarship` | Scholarships, bursaries, grants for students |
| `Funding` | TETFund allocations, research funding, infrastructure budgets |
| `Appointments` | Vice-chancellors, registrars, governing councils, appointments |
| `Policy` | ASUU, strikes, ministry policy, education reform |
| `Research` | Studies, publications, breakthroughs, conferences |
| `Campus` | Student union, campus events, hostel and campus life |
| `Education` | Fallback when no more specific rule matches |

Classification is rule-based scoring over the title, excerpt, body and the feed's
own categories. A source's default category is used as the fallback.

---

## Errors

Every error uses the same shape:

```json
{
  "error": "invalid_query",
  "message": "Invalid query parameters",
  "details": [
    { "path": "limit", "message": "Number must be less than or equal to 100" }
  ]
}
```

| Status | `error` | Meaning |
| --- | --- | --- |
| `400` | `invalid_query` | A query parameter failed validation |
| `400` | `invalid_id` | Article id is not a hex string |
| `401` | `unauthorized` | Missing or wrong `x-ingest-token` |
| `404` | `not_found` | Unknown route, unknown article, or expired article |
| `404` | `not_enabled` | `POST /api/ingest` called with no `INGEST_TOKEN` configured |
| `429` | `rate_limit_exceeded` | Too many requests from this IP |
| `500` | `internal_error` | Unexpected server error (details are logged, not returned) |
| `503` | — | `/api/health` only: Redis unreachable |

---

## Rate limiting and caching

**Rate limit.** A fixed window of `RATE_LIMIT_PER_MINUTE` requests per IP
(default 120; `0` disables). Responses carry:

```
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 118
Retry-After: 42          # only on 429
```

**Response cache.** Identical `/api/news` queries are cached in Redis for
`RESPONSE_CACHE_SECONDS` (default 60). Successful `/api/news` responses also send
`Cache-Control: public, max-age=<min(cache, 300)>`.

Set `RESPONSE_CACHE_SECONDS=0` to disable caching, which is what the test suite
does.

---

## CORS

Controlled by `CORS_ORIGINS`, comma-separated, default `*`. `GET, POST` and
`OPTIONS` are allowed, with `Content-Type` and `x-ingest-token` as allowed
headers.
