# Source coverage

32 Nigerian publishers and authorities are registered. This document records
what each one actually does, how it is read, and how to add another.

Everything here was verified live against the publishers' own endpoints rather
than assumed from a list, so it doubles as a record of what is collectable as of
**21 November 2026**.

---

## Summary

| | Count |
| --- | --- |
| Registered | 32 |
| Active | 26 |
| Working with no extra setup | 24 |
| Need a headless browser | 2 |
| Documented as not collectable | 3 |
| Dead domains | 3 |

A full pass discovers roughly **500 items**, stores about **230 articles across
24 sources**, and takes **40–50 seconds**.

---

## Official authorities (primary sources)

Treated as high priority: they are visited first, so an official notice wins the
title-fingerprint dedupe against a paper writing the same story.

| Source | id | How it is read | Status |
| --- | --- | --- | --- |
| National Universities Commission | `nuc` | RSS feed, page extraction | **Working** |
| TETFund | `tetfund` | Scraped listing page, page extraction | **Working** |
| Federal Ministry of Education | `fme` | RSS feed, full body in feed | **Working** |
| Joint Admissions and Matriculation Board | `jamb` | — | **Not collectable** |
| National Board for Technical Education | `nbte` | — | **Not collectable** |
| National Commission for Colleges of Education | `ncce` | — | **Not collectable** |

### Why JAMB, NBTE and NCCE are off

These three were probed directly and none of them publishes article-style news:

- **JAMB** — `jamb.gov.ng/news` is a downloads index of PDFs and installers, not
  articles. Google News indexes exactly three URLs for the domain: a
  candidate-portal **logout page**, the homepage, and one PDF. There is no feed.
- **NBTE** — `nbte.gov.ng` redirects to `web.nbte.gov.ng`, which has no feed and
  no news listing. Google News does index ~55 pages, but they are
  `digitalnbte.nbte.gov.ng/Public/Institutions/…` directory records of about
  23 words each. They are database rows, not news.
- **NCCE** — `/news` sits behind an ASP.NET login wall, there is no feed, and
  Google News indexes **zero** pages for the domain.

Storing directory records as "news" would pollute the API, so all three are
registered with `disabled: true` and an explicit `disabled_reason` that appears
in `GET /api/sources`. Their announcements are still captured through
MySchoolGist, Current School News and the national papers.

Re-enable any of them by removing `disabled` in `src/sources/registry.ts` once
they publish a real feed.

---

## National newspapers

Serious tertiary-education journalism: policy, investigations, appointments and
national developments.

| Source | id | Discovery | Body from | Status |
| --- | --- | --- | --- | --- |
| Punch Newspapers | `punch` | RSS | Article page | **Working** |
| Vanguard | `vanguard` | RSS | Feed | **Working** |
| Premium Times | `premiumtimes` | RSS (2 feeds merged) | Article page | **Working** |
| ThisDay | `thisday` | RSS | Feed | **Working** |
| Daily Post Nigeria | `dailypost` | RSS (2 feeds merged) | Feed | **Working** |
| BusinessDay | `businessday` | RSS (2 feeds merged) | Article page | **Working** |
| Nigerian Tribune | `tribune` | RSS | Article page | **Working** |
| Channels Television | `channelstv` | RSS | Feed | **Working** |
| The Guardian Nigeria | `guardian-ng` | Google News | Article page | **Needs browser** |
| TheCable | `thecable` | Google News | Article page | **Needs browser** |

### Premium Times needed feed merging

Its education category feed (`/category/news/education/feed/`) is often **weeks
stale** — at the time of writing its newest item was 22 October while the main
feed carried that morning's stories. The source therefore lists both feeds and
the collector merges them, so a stale category feed cannot hide fresh news.

### Why Guardian and TheCable need a browser

Both are behind a Cloudflare JavaScript challenge. Every direct route returns
`403` to a plain HTTP client:

| Endpoint | Result |
| --- | --- |
| `guardian.ng/feed/` | `403` |
| `guardian.ng/sitemap.xml` | `403` |
| `guardian.ng/robots.txt` | `403` |
| article HTML | `403` |
| `thecable.ng/feed` | `403` |

There is no feed to fall back on, so discovery runs through **Google News**,
which still indexes both publishers and supplies headline, timestamp and the
real article URL. The article body then requires a real browser:

```bash
npm i playwright
npx playwright install --with-deps chromium
ENABLE_BROWSER_RENDERER=true npm run dev
```

With the renderer off, these two report
`requires ENABLE_BROWSER_RENDERER=true (Playwright + Chromium)` in
`GET /api/sources`, and the collector skips them early rather than paying for
Google News resolution it cannot use.

---

## Education specialists

Student information, admissions, scholarships and campus developments. This is
where most Nigerian tertiary-education detail originates.

| Source | id | Discovery | Body from | Status |
| --- | --- | --- | --- | --- |
| MySchoolGist | `myschoolgist` | RSS | Auto | **Working** |
| MySchool.ng | `myschool` | Scraped listing | Article page | **Working** |
| Campus Info | `campusinfo` | RSS | Auto | **Working** |
| Edugist | `edugist` | RSS | Feed | **Working** |
| Current School News | `currentschoolnews` | RSS | Article page | **Working** |
| Schoolings | `schoolings` | RSS | Article page | **Working** |
| Nigeria School News | `nigeriaschoolnews` | RSS | Feed | **Working** |
| FlashLearners | `flashlearners` | RSS | Article page | **Working** |
| Studentship | `studentship` | RSS | Article page | **Working** |
| Bscholarly | `bscholarly` | RSS | Article page | **Working** |
| Martins Library | `martinslibrary` | RSS | Feed | **Working** |
| Scholarship Region | `scholarshipregion` | RSS | Article page | **Working** |
| EduPodia | `edupodia` | RSS | Article page | **Working** |

### Two needed special handling

- **MySchool.ng** has no feed at all. It is read by scraping its
  `/news` listing and following each article link, with dates inferred from the
  card text (`18 Nov`, `Nov 20, 2026`, `2 days ago`) and a year inferred when the
  month has not yet arrived. It is the single largest contributor — about 90
  articles per pass.
- **MySchoolGist** returns `403` to a self-identifying bot user-agent but serves
  its feed normally to a browser string. This is why the default `USER_AGENT` is
  a desktop browser; politeness is enforced by per-host throttling and
  conditional GET instead.

### Low-frequency publishers

Six specialists publish infrequently and often contribute **zero** articles to a
10-day window. This is correct behaviour, not a failure:

| Source | Newest item at time of writing |
| --- | --- |
| Current School News | April 2025 |
| Studentship | August 2026 |
| EduPodia | September 2026 |
| Schoolings | 12 October 2026 |
| Nigeria School News | outside window |
| FlashLearners | outside window |

They are still worth registering: when they do publish, it is usually
admissions information that students need.

---

## Dead domains

| Source | Failure |
| --- | --- |
| Campus Portal | DNS does not resolve |
| Educatinfo | Domain expired / HTTP 410 |
| Nigerian Scholars | DNS does not resolve |

Registered with `disabled: true` and a reason, so the API documents the gap
instead of silently omitting them.

---

## Google News topic discovery

Beyond per-source collection, `npm run ingest -- --discovery` (or
`POST /api/ingest?discovery=true`) runs broad queries and attributes each result
back to a registered publisher by hostname:

```
Nigeria university news          Nigerian university admissions
Nigeria polytechnic news         Nigerian university research
Nigeria tertiary education       Nigerian campus news
Nigerian university lecturers    NUC accreditation Nigeria
ASUU news Nigeria                Nigerian university convocation
```

Only items whose publisher host matches a registered source are kept, so
discovery widens coverage without importing unvetted sites.

### How the Google News redirect is unwrapped

Google returns opaque links (`news.google.com/rss/articles/CBMi…`) rather than
the publisher URL. Each one is unwrapped by:

1. fetching the interstitial page and reading its signed
   `data-n-a-ts` / `data-n-a-sg` pair;
2. posting that pair to `news.google.com/_/DotsSplashUi/data/batchexecute`
   as a `f.req` form field;
3. reading the `garturlres` value out of the response.

Resolved URLs are cached in-process, and items are dropped rather than emitted
with a Google link if unwrapping fails or the host does not match the source.

---

## How a source is read

Each source declares three things in `src/sources/registry.ts`:

```ts
{
  id: 'edugist',
  name: 'Edugist',
  homepage: 'https://edugist.org',
  tier: 'specialist',          // authority | national | specialist
  discovery: 'rss',            // rss | html-list | google-news
  feeds: ['https://edugist.org/feed/'],
  content: 'feed',             // feed | page | auto | excerpt
  defaultCategory: 'Education',
  focus: 'education',          // education | general | authority
  country: 'Nigeria',
  language: 'en',
}
```

### `discovery`

| Value | Use when |
| --- | --- |
| `rss` | There is a usable RSS/Atom feed. Multiple `feeds` are merged. |
| `html-list` | No feed, but a server-rendered listing page exists. Needs selectors. |
| `google-news` | Every direct endpoint is blocked, or the site has no listing. |

### `content`

| Value | Behaviour |
| --- | --- |
| `feed` | Always use the feed body. Best when the feed carries full articles. |
| `page` | Always fetch the article page and extract with Readability. |
| `auto` | Use the feed body if it is substantial, otherwise fetch the page. |
| `excerpt` | Never fetch; store the feed summary only. |

### `focus` — how strictly to filter

`focus` controls the relevance bar, because a general newspaper's feed carries
sport and politics while an education site's feed is almost all on-topic:

| `focus` | Behaviour |
| --- | --- |
| `education` | Accept unless it matches the spam blocklist; a bare feed category of "Education" is enough |
| `general` | Require at least one strong education term in the title or body |
| `authority` | Accept nearly everything — an official notice is news by definition |

The blocklist rejects casino, betting and affiliate spam (`slot gacor`, `togel`,
`1xbet`, `bet9ja`, `expo`, …) that leaks into some campus feeds.

---

## Adding a source

1. **Check it is collectable.**

   ```bash
   curl -sI "https://example.com/feed/" | head -1
   curl -s "https://example.com/feed/" | grep -c "<item>"
   ```

   A `200` with items means `discovery: 'rss'` will work. A `403` means you
   need `google-news` plus the browser renderer.

2. **Add the entry** to `src/sources/registry.ts` with a `tier`, `discovery`,
   `content` and `focus`.

3. **Probe it.**

   ```bash
   npm run ingest:sources -- --source=example
   ```

   This reports item count, whether the feed carries full bodies, and whether the
   first article page extracts cleanly.

4. **Run it for real.**

   ```bash
   npm run ingest -- --source=example
   ```

   Check the `NEW`, `OLD`, `IRREL` and `FAIL` columns. A high `FAIL` usually means
   the page needs the browser renderer; a high `IRREL` means the relevance bar
   is too loose for that publisher.

5. **Add tests** if you added a new extraction or discovery pattern.

### Adding an HTML-scraped listing

`html-list` sources need CSS selectors:

```ts
discovery: 'html-list',
htmlList: {
  url: 'https://myschool.ng/news',
  itemSelector: 'article, .post, li.item',
  linkSelector: 'a',
  titleSelector: 'h2, h3',
  dateSelector: '.date, time',
  linkPattern: '^/news/',   // only follow article links
},
```

Dates are read from `dateSelector`, then from the card text, then from the
nearest container. Supported formats include `18 Nov`, `20 November 2026`,
`Nov 20, 2026` and `2 days ago`, with the year inferred when absent.

---

## Health monitoring

`GET /api/sources` reports per-source health, and a source is only marked failed
after its own discovery step fails:

```json
"health": {
  "last_run": "2026-11-21T01:42:12Z",
  "last_ok": "2026-11-21T01:42:12Z",
  "last_error": null,
  "consecutive_failures": 0,
  "last_discovered": 25,
  "last_stored": 25
}
```

`consecutive_failures` is the field to alert on: one bad pass is normal, three in
a row means the publisher changed something.
