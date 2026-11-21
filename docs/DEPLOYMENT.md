# Deployment

The service is two processes' worth of state: a stateless Node API and a Redis
instance. Everything else is optional.

---

## Contents

- [Requirements](#requirements)
- [Docker Compose (single host)](#docker-compose-single-host)
- [Docker with managed Redis](#docker-with-managed-redis)
- [Managed Redis options](#managed-redis-options)
- [Bare VPS with systemd](#bare-vps-with-systemd)
- [Railway, Render and Fly.io](#railway-render-and-flyio)
- [Scheduling ingestion](#scheduling-ingestion)
- [Enabling the browser renderer](#enabling-the-browser-renderer)
- [Scaling](#scaling)
- [Monitoring](#monitoring)
- [Security checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)

---

## Requirements

| | Minimum | Notes |
| --- | --- | --- |
| Node | 20.11+ | 22 LTS recommended |
| Redis | 6.2+ | 7.x recommended |
| RAM | 256 MB | 512 MB with the browser renderer |
| Disk | 200 MB | The image is ~180 MB; Redis holds a few MB of news |

No database is needed. Redis is the only datastore.

---

## Docker Compose (single host)

The fastest complete deployment: API plus Redis on one machine.

```bash
git clone https://github.com/wisdom-technologies-bit/edu-news.git
cd edu-news
cp .env.example .env      # optional: edit before starting
docker compose up -d --build
docker compose logs -f api
```

Verify:

```bash
curl -fsS http://localhost:8080/api/health | jq
curl -fsS "http://localhost:8080/api/news?limit=2" | jq '.meta'
```

The stack:

- `redis` — `redis:7-alpine`, `maxmemory 512mb`, `volatile-lru`, persistence
  off (news is a cache with a short life).
- `api` — the multi-stage image, running unprivileged as uid 1001, with a
  `HEALTHCHECK` against `/api/health`.

Ingestion starts automatically on boot and repeats every 30 minutes.

### Useful commands

```bash
docker compose logs -f api              # follow logs
docker compose exec api node -e "console.log('ok')"
docker compose restart api              # pick up new env vars
docker compose down                     # stop (keeps the redis volume)
docker compose down -v                  # stop and wipe the cache
```

### Editing configuration

`docker-compose.yml` sets the important variables directly. To override without
editing the file, create a `.env` next to it — Compose substitutes `${VAR}`:

```bash
INGEST_TOKEN=$(openssl rand -hex 32)
CORS_ORIGINS=https://futocentral.example.com
LOG_LEVEL=info
```

---

## Docker with managed Redis

For a platform that provides Redis, run only the API.

```bash
docker build -t edu-news:latest .

docker run -d --name edu-news \
  -p 8080:8080 \
  -e REDIS_URL="rediss://default:PASSWORD@your-redis-host:6379" \
  -e INGEST_LOOKBACK_DAYS=10 \
  -e INGEST_INTERVAL_MINUTES=30 \
  -e INGEST_TOKEN="$(openssl rand -hex 32)" \
  -e CORS_ORIGINS="https://futocentral.example.com" \
  -e CONTACT_EMAIL="you@example.com" \
  --restart unless-stopped \
  edu-news:latest
```

`rediss://` (double `s`) enables TLS, which managed providers require. The
connection string accepts the password and database number inline:
`redis://:password@host:6379/0`.

If you prefer discrete settings, leave `REDIS_URL` empty and set
`REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_TLS=true`.

---

## Managed Redis options

Any Redis 6.2+ provider works. Things to configure:

| Setting | Value | Why |
| --- | --- | --- |
| Eviction policy | `volatile-lru` or `noeviction` | Every article key has a TTL, so `volatile-*` only evicts news |
| Persistence | Optional | The cache rebuilds itself on the next pass |
| TLS | On, use `rediss://` | Required by most managed providers |
| Memory | 128–512 MB | 500 articles is a few MB; this is generous headroom |

**Upstash** — serverless, generous free tier, works well with `rediss://`.

```
REDIS_URL=rediss://default:PASSWORD@region.upstash.io:6379
```

**Redis Cloud / ElastiCache / DigitalOcean Managed Redis** — all work with the
same URL form. For ElastiCache with in-transit encryption, set
`REDIS_TLS=true` and use the cluster's configuration endpoint.

> **Note on `mock://`.** `REDIS_URL=mock://` runs an in-memory backend with no
> Redis at all. It exists for development, CI and evaluation. Never deploy it to
> production: data is lost on restart and is not shared between processes.

---

## Bare VPS with systemd

Ubuntu 22.04/24.04, no Docker.

```bash
# 1. Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs redis-server

# 2. Redis: cap memory, evict only keys with a TTL
sudo sed -i 's/^# maxmemory .*/maxmemory 512mb/' /etc/redis/redis.conf
sudo sed -i 's/^# maxmemory-policy .*/maxmemory-policy volatile-lru/' /etc/redis/redis.conf
sudo systemctl enable --now redis-server

# 3. The app
sudo useradd --system --create-home --shell /usr/sbin/nologin edunews
sudo -u edunews git clone https://github.com/wisdom-technologies-bit/edu-news.git /opt/edu-news
cd /opt/edu-news
sudo -u edunews npm ci
sudo -u edunews npm run build
sudo -u edunews npm prune --omit=dev
```

Create `/etc/edu-news.env`:

```ini
NODE_ENV=production
PORT=8080
HOST=127.0.0.1
REDIS_URL=redis://127.0.0.1:6379/0
INGEST_LOOKBACK_DAYS=10
RETENTION_DAYS=21
INGEST_INTERVAL_MINUTES=30
INGEST_ON_BOOT=true
CORS_ORIGINS=https://futocentral.example.com
INGEST_TOKEN=replace-with-a-long-random-string
CONTACT_EMAIL=you@example.com
LOG_LEVEL=info
```

```bash
sudo chmod 600 /etc/edu-news.env
sudo chown edunews:edunews /etc/edu-news.env
```

`/etc/systemd/system/edu-news.service`:

```ini
[Unit]
Description=edu-news API
After=network-online.target redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=edunews
Group=edunews
WorkingDirectory=/opt/edu-news
EnvironmentFile=/etc/edu-news.env
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=5

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/edu-news

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now edu-news
sudo systemctl status edu-news
journalctl -u edu-news -f
```

### Reverse proxy with nginx

```nginx
server {
    listen 443 ssl http2;
    server_name news.example.com;

    ssl_certificate     /etc/letsencrypt/live/news.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/news.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

`app.set('trust proxy', true)` is already enabled, so rate limiting sees real
client IPs behind the proxy.

---

## Railway, Render and Fly.io

All three build from the `Dockerfile` with no changes.

### Railway

```bash
railway init
railway add --plugin redis        # provisions Redis and sets REDIS_URL
railway variables set INGEST_INTERVAL_MINUTES=30 INGEST_ON_BOOT=true
railway up
```

Railway injects `REDIS_URL` automatically. Do not set `PORT`; it is provided.

### Render

Create a **Blueprint** (`render.yaml`) or use the dashboard:

```yaml
services:
  - type: web
    name: edu-news
    runtime: docker
    dockerfilePath: ./Dockerfile
    healthCheckPath: /api/health
    envVars:
      - key: INGEST_LOOKBACK_DAYS
        value: "10"
      - key: INGEST_INTERVAL_MINUTES
        value: "30"
      - key: INGEST_ON_BOOT
        value: "true"
      - key: REDIS_URL
        fromService:
          type: redis
          name: edu-news-redis
          property: connectionString

  - type: redis
    name: edu-news-redis
    plan: starter
    maxmemoryPolicy: volatile-lru
```

> Render's free tier sleeps after inactivity, which stops the internal
> scheduler. Either use a paid instance, or drive ingestion from a scheduled job
> (see below).

### Fly.io

```bash
fly launch --no-deploy
fly redis create                  # or attach Upstash
fly secrets set REDIS_URL="rediss://..." INGEST_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

Add to `fly.toml` so the platform probes the right path:

```toml
[[http_service.checks]]
  interval = "30s"
  timeout = "5s"
  grace_period = "20s"
  method = "GET"
  path = "/api/health"
```

Keep one machine (`fly scale count 1`): two instances would run two schedulers.
The Redis lock prevents duplicate work, but one instance is simpler.

---

## Scheduling ingestion

Three options. Use exactly one.

### 1. Internal scheduler (default)

```ini
INGEST_INTERVAL_MINUTES=30
INGEST_ON_BOOT=true
```

Runs inside the API process. Simple, and the right default for a long-lived
container or VM. Set `INGEST_INTERVAL_MINUTES=0` to disable.

### 2. Cron against the API

Best for serverless platforms that sleep, or when you want the schedule
independent of the app.

```ini
# /etc/cron.d/edu-news — every 20 minutes
*/20 * * * * edunews curl -fsS -X POST "http://127.0.0.1:8080/api/ingest" \
  -H "x-ingest-token: $INGEST_TOKEN" >> /var/log/edu-news-ingest.log 2>&1
```

With the scheduler disabled:

```ini
INGEST_INTERVAL_MINUTES=0
INGEST_ON_BOOT=false
```

### 3. Cron running the CLI directly

Useful when the API is read-only and you want ingestion to be a separate job
that can fail loudly.

```bash
cd /opt/edu-news
INGEST_ONLY_SOURCES=punch,edugist,myschoolgist node dist/scripts/ingest.js --json
```

The CLI exits `0` when at least one source succeeded and `1` when all failed, so
cron and systemd can alert on it.

> **Note.** A short interval does not mean fresher news, because feeds update on
> the publishers' own schedule. 20–30 minutes is a sensible floor; going faster
> mainly increases load on them.

---

## Enabling the browser renderer

Needed only for **The Guardian Nigeria** and **TheCable**, which sit behind a
Cloudflare JavaScript challenge. Both are optional: the other 24 sources work
without it.

### Locally

```bash
npm i playwright
npx playwright install --with-deps chromium
ENABLE_BROWSER_RENDERER=true npm run dev
```

### In Docker

Playwright needs system libraries, so extend the image:

```dockerfile
# Dockerfile.browser
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app
ENV NODE_ENV=production ENABLE_BROWSER_RENDERER=true

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY dist ./dist
COPY docs ./docs

RUN useradd --create-home --uid 1001 app && chown -R app:app /app
USER app

EXPOSE 8080
CMD ["node", "dist/src/index.js"]
```

Build the app first (`npm run build`), then:

```bash
docker build -f Dockerfile.browser -t edu-news:browser .
docker run -d -p 8080:8080 -e REDIS_URL=rediss://... edu-news:browser
```

Budget roughly +400 MB of image size and +300 MB RAM per browser instance.
Concurrency is capped by `BROWSER_CONCURRENCY` (default 1) to keep that
predictable.

### When the renderer is off

The two sources report
`requires ENABLE_BROWSER_RENDERER=true (Playwright + Chromium)` in
`GET /api/sources`, and the collector skips them early instead of spending
requests on Google News resolution it cannot use.

---

## Scaling

The API is stateless; Redis is the only shared state.

**Vertical first.** A single 512 MB instance handles a full pass in about 45
seconds while serving requests. Most deployments never need more.

**Multiple API replicas.** Run N replicas behind a load balancer, all pointing at
the same Redis, with:

```ini
INGEST_INTERVAL_MINUTES=0     # on every replica
```

and one of:

- one dedicated ingestion worker running `INGEST_INTERVAL_MINUTES=30` with
  `INGEST_ON_BOOT=false`, or
- cron calling `POST /api/ingest` on any replica.

The ingestion lock (`edunews:lock:ingest`, 15-minute TTL) already prevents
overlapping passes, so even a misconfiguration will not double-write.

**Tuning knobs.**

| Variable | Effect |
| --- | --- |
| `FETCH_CONCURRENCY` | Parallel requests per pass. Raise for speed, lower to be gentler on publishers. Default 8. |
| `PER_HOST_DELAY_MS` | Gap between requests to one publisher. Default 750 ms. Do not go below ~250 ms. |
| `RESPONSE_CACHE_SECONDS` | Longer means fewer Redis reads under load. Default 60. |
| `MAX_INDEX_SIZE` | Cap on indexed articles. Default 8000. |
| `RATE_LIMIT_PER_MINUTE` | Per-IP limit. Default 120; `0` disables. |

---

## Monitoring

**Health.** `GET /api/health` returns `200` healthy, `503` when Redis is
unreachable. Wire it into the platform's health check or your uptime monitor.

**What to alert on.**

| Signal | Threshold |
| --- | --- |
| `/api/health` non-200 | 2 consecutive checks |
| `stats.articles` | 0 for more than ~2 hours |
| `stats.newest_age` | Older than ~6 hours during the day |
| `sources[].consecutive_failures` | ≥ 3 on any active source |
| `last_ingestion.sources_ok` | Below half of `sources_total` |

**Logs.** Structured JSON via pino. Useful fields: `msg: "ingestion finished"`
with `stored`, `discovered`, `ok`, `failed`; `msg: "feed parsed"` per source;
`msg: "redis error"`.

Set `LOG_PRETTY=true` locally for human-readable output.

**A quick smoke test:**

```bash
curl -fsS "$BASE/api/stats" | jq '{
  articles: .data.articles,
  newest: .data.newest_age,
  sources_ok: .data.last_ingestion.sources_ok,
  sources_failed: .data.last_ingestion.sources_failed
}'
```

Expected shape:

```json
{ "articles": 233, "newest": "3h ago", "sources_ok": 24, "sources_failed": 2 }
```

---

## Security checklist

- [ ] Set `INGEST_TOKEN` to a long random value if you enable `POST /api/ingest`
      (`openssl rand -hex 32`). Without it the route is `404`.
- [ ] Restrict `CORS_ORIGINS` to your frontend instead of `*`.
- [ ] Use `rediss://` and a password for Redis. Do not expose Redis to the
      internet; bind it to localhost or a private network.
- [ ] Set `CONTACT_EMAIL` so publishers can reach you about crawling.
- [ ] Keep `RATE_LIMIT_PER_MINUTE` above 0 on a public deployment.
- [ ] Run behind TLS. `X-Forwarded-*` is trusted, so terminate TLS at the proxy.
- [ ] Keep the container non-root (the provided image already is).
- [ ] Do not commit `.env`. It is git-ignored.

---

## Troubleshooting

**`cannot reach Redis — the API needs Redis for storage`**

Redis is not reachable at startup. The process exits with code 1 by design
rather than serving an empty API. Check `REDIS_URL`, that Redis is running, and
that the password/database are correct. For a quick local check:
`REDIS_URL=mock:// npm run dev`.

**`/api/news` returns an empty `data` array**

Run one pass and read the report:

```bash
docker compose exec api node dist/scripts/ingest.js --json | jq '.stored, .reports'
```

- `stored: 0` with a high `skipped_out_of_window` → the feeds are stale, which
  is normal for low-frequency publishers.
- `stored: 0` with many `failed_extractions` → the pages need the browser
  renderer.
- `stored: 0` with a high `skipped_irrelevant` → the `focus` setting is too
  strict for that publisher.

**`sources_failed` is 2 and they are Guardian and TheCable**

Expected without `ENABLE_BROWSER_RENDERER=true`. See
[enabling the browser renderer](#enabling-the-browser-renderer).

**A source suddenly fails**

Publishers change markup. Run the probe:

```bash
docker compose exec api node dist/scripts/probe-sources.js --source=example
```

It reports whether the feed still returns items, whether it still carries full
bodies, and whether the first article page still extracts.

**429 responses**

`RATE_LIMIT_PER_MINUTE` is too low for your traffic, or a client is polling.
Responses include `Retry-After`.

**Container restarts in a loop**

Check `docker compose logs api`. The usual causes are a malformed `REDIS_URL` or
an unreachable Redis host. The health check starts after a 20-second grace
period, so a slow first pass is not the cause.

**Stale data after a deploy**

Redis persists across restarts by design. To force a clean rebuild:

```bash
docker compose down -v && docker compose up -d --build
```

or, without Docker, delete the keys:

```bash
redis-cli --scan --pattern 'edunews:*' | xargs -r redis-cli del
```
