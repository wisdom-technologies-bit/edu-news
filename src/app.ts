import express, { type Request, type Response } from 'express';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { api } from './api/routes.js';
import { SOURCES, ACTIVE_SOURCES } from './sources/registry.js';
import { DISCOVERY_QUERIES } from './sources/types.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '256kb' }));

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === '/api/health' || req.url === '/health',
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'debug';
      },
    }),
  );

  // ── CORS ────────────────────────────────────────────────────────────────
  const allowed = config.server.corsOrigins;
  app.use((req, res, next) => {
    const origin = req.get('origin');
    const allowAll = allowed.includes('*');

    if (allowAll) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ingest-token');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // ── Landing page ────────────────────────────────────────────────────────
  app.get('/', (_req: Request, res: Response) => {
    const activeByTier = {
      authority: ACTIVE_SOURCES.filter((s) => s.tier === 'authority').length,
      national: ACTIVE_SOURCES.filter((s) => s.tier === 'national').length,
      specialist: ACTIVE_SOURCES.filter((s) => s.tier === 'specialist').length,
    };

    res.type('html').send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>edu-news · Nigerian education news API</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --muted:#666; --bg:#fafaf8; --line:#e5e5e0; --accent:#0a5c3e; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eee; --muted:#9a9a9a; --bg:#111312; --line:#2a2e2c; --accent:#6ee7b7; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:3rem 1.25rem; background:var(--bg); color:var(--fg);
         font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size:1.75rem; margin:0 0 .25rem; letter-spacing:-.02em; }
  p.lede { color:var(--muted); margin:0 0 2rem; }
  h2 { font-size:.78rem; text-transform:uppercase; letter-spacing:.09em; color:var(--muted);
       margin:2.25rem 0 .6rem; font-weight:600; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.86em;
         background:color-mix(in srgb, var(--fg) 8%, transparent); padding:.12em .38em; border-radius:4px; }
  ul { list-style:none; padding:0; margin:0; }
  li { padding:.5rem 0; border-bottom:1px solid var(--line); display:flex; gap:.75rem;
       align-items:baseline; flex-wrap:wrap; }
  li:last-child { border-bottom:0; }
  li code { flex:0 0 auto; color:var(--accent); background:none; padding:0; font-weight:600; }
  li span { color:var(--muted); font-size:.9em; }
  .stats { display:flex; gap:2rem; flex-wrap:wrap; margin:1.5rem 0 0; padding:1rem 1.25rem;
           border:1px solid var(--line); border-radius:10px; }
  .stats div { font-size:.9em; color:var(--muted); }
  .stats b { display:block; font-size:1.5rem; color:var(--fg); font-weight:600; line-height:1.2; }
  a { color:var(--accent); }
</style></head><body><main>
  <h1>edu-news</h1>
  <p class="lede">Nigerian education news, last ${config.ingest.lookbackDays} days, as clean Markdown.</p>

  <div class="stats">
    <div><b>${ACTIVE_SOURCES.length}</b>active sources</div>
    <div><b>${activeByTier.authority}</b>authorities</div>
    <div><b>${activeByTier.national}</b>national papers</div>
    <div><b>${activeByTier.specialist}</b>education publishers</div>
    <div><b>${DISCOVERY_QUERIES.length}</b>discovery queries</div>
  </div>

  <h2>Endpoints</h2>
  <ul>
    <li><code>GET /api/news</code><span>Latest articles (default: last ${config.api.defaultDays} days)</span></li>
    <li><code>GET /api/news/:id</code><span>Single article</span></li>
    <li><code>GET /api/sources</code><span>Source directory and per-source health</span></li>
    <li><code>GET /api/facets</code><span>Categories, institutions and sources in the window</span></li>
    <li><code>GET /api/stats</code><span>Aggregate counts and last ingestion summary</span></li>
    <li><code>GET /api/health</code><span>Liveness and Redis status</span></li>
    <li><code>POST /api/ingest</code><span>Force a collection pass (needs <code>x-ingest-token</code>)</span></li>
  </ul>

  <h2>Try it</h2>
  <ul>
    <li><a href="/api/news?limit=5">/api/news?limit=5</a></li>
    <li><a href="/api/news?category=Admissions&amp;days=10">/api/news?category=Admissions</a></li>
    <li><a href="/api/news?q=FUTO">/api/news?q=FUTO</a></li>
    <li><a href="/api/sources">/api/sources</a></li>
    <li><a href="/api/stats">/api/stats</a></li>
  </ul>
</main></body></html>`);
  });

  app.use('/api', api);

  // ── Error handler ───────────────────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
  });

  logger.debug({ sources: SOURCES.length }, 'app created');
  return app;
}
