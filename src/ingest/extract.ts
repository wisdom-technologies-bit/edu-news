import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { fetchUrl } from './fetcher.js';
import { htmlToMarkdown, type MarkdownResult } from './markdown.js';

export interface ExtractedPage {
  ok: boolean;
  url: string;
  title: string | null;
  byline: string | null;
  siteName: string | null;
  publishedTime: string | null;
  excerpt: string | null;
  leadImage: string | null;
  markdown: MarkdownResult;
  status: number;
  error?: string;
}

/** jsdom is noisy about modern CSS; silence it so logs stay readable. */
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', () => {
  /* ignore: stylesheet parse failures are expected and harmless */
});

function metaContent($doc: Document, selectors: string[]): string | null {
  for (const selector of selectors) {
    const el = $doc.querySelector(selector);
    const value = el?.getAttribute('content');
    if (value && value.trim()) return value.trim();
  }
  return null;
}

function absoluteUrl(candidate: string | null, base: string): string | null {
  if (!candidate) return null;
  try {
    const u = new URL(candidate, base).toString();
    return /^https?:/.test(u) ? u : null;
  } catch {
    return null;
  }
}

/**
 * Fetch an article page and extract its main body as Markdown.
 *
 * Readability strips navigation, adverts and footers, leaving the publisher's
 * own article markup, which is then converted to Markdown with images intact.
 */
export async function extractArticle(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<ExtractedPage> {
  const empty = (status: number, error?: string): ExtractedPage => ({
    ok: false,
    url,
    title: null,
    byline: null,
    siteName: null,
    publishedTime: null,
    excerpt: null,
    leadImage: null,
    markdown: { markdown: '', images: [], wordCount: 0 },
    status,
    error,
  });

  const res = await fetchUrl(url, {
    timeoutMs: opts.timeoutMs,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  });

  if (!res.ok || !res.body) {
    return empty(res.status, res.error ?? `HTTP ${res.status}`);
  }

  const finalUrl = res.url || url;

  let dom: JSDOM;
  try {
    dom = new JSDOM(res.body, { url: finalUrl, virtualConsole });
  } catch (err) {
    return empty(res.status, `dom parse failed: ${(err as Error).message}`);
  }

  const doc = dom.window.document;

  // Page-level metadata, captured before Readability mutates the DOM.
  const ogImage = metaContent(doc, [
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
  ]);
  const publishedMeta = metaContent(doc, [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[name="date"]',
    'meta[itemprop="datePublished"]',
    'meta[name="pubdate"]',
    'meta[name="publish-date"]',
  ]);
  const siteNameMeta = metaContent(doc, ['meta[property="og:site_name"]']);

  let article: ReturnType<Readability['parse']> = null;
  try {
    const reader = new Readability(doc, {
      charThreshold: 180,
      keepClasses: false,
    });
    article = reader.parse();
  } catch (err) {
    logger.debug({ url, err: (err as Error).message }, 'readability failed');
  }

  if (!article || !article.content) {
    // Fall back to the largest <article>/<main> block before giving up.
    const fallback = doc.querySelector('article') ?? doc.querySelector('main') ?? doc.body;
    const fallbackHtml = fallback?.innerHTML ?? '';
    const md = htmlToMarkdown(fallbackHtml, finalUrl);
    if (md.wordCount < 40) {
      return empty(res.status, 'no readable content');
    }
    return {
      ok: true,
      url: finalUrl,
      title: doc.title || null,
      byline: null,
      siteName: siteNameMeta,
      publishedTime: publishedMeta,
      excerpt: null,
      leadImage: absoluteUrl(ogImage, finalUrl),
      markdown: md,
      status: res.status,
    };
  }

  const md = htmlToMarkdown(article.content, finalUrl);

  return {
    ok: true,
    url: finalUrl,
    title: article.title?.trim() || null,
    byline: article.byline?.trim() || null,
    siteName: article.siteName?.trim() || siteNameMeta,
    publishedTime: publishedMeta,
    excerpt: article.excerpt?.trim() || null,
    leadImage: absoluteUrl(ogImage, finalUrl) ?? md.images[0] ?? null,
    markdown: {
      markdown: md.markdown.slice(0, config.ingest.maxContentChars),
      images: md.images,
      wordCount: md.wordCount,
    },
    status: res.status,
  };
}

/**
 * Optional headless-Chromium path for publishers behind a Cloudflare JS
 * challenge. Only loaded when ENABLE_BROWSER_RENDERER=true and Playwright is
 * installed, so the default install stays dependency-light.
 */
export async function extractArticleWithBrowser(url: string): Promise<ExtractedPage> {
  if (!config.extraction.enableBrowserRenderer) {
    return {
      ok: false, url, title: null, byline: null, siteName: null, publishedTime: null,
      excerpt: null, leadImage: null,
      markdown: { markdown: '', images: [], wordCount: 0 },
      status: 0,
      error: 'browser renderer disabled (set ENABLE_BROWSER_RENDERER=true)',
    };
  }

  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return {
      ok: false, url, title: null, byline: null, siteName: null, publishedTime: null,
      excerpt: null, leadImage: null,
      markdown: { markdown: '', images: [], wordCount: 0 },
      status: 0,
      error: 'playwright not installed (npm i playwright && npx playwright install chromium)',
    };
  }

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({
      userAgent: config.userAgent,
      locale: 'en-NG',
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.ingest.timeoutMs * 2 });
    // Give the Cloudflare interstitial time to resolve.
    await page.waitForTimeout(3500);
    const html = await page.content();
    const finalUrl = page.url();

    const dom = new JSDOM(html, { url: finalUrl, virtualConsole });
    const article = new Readability(dom.window.document, { charThreshold: 180 }).parse();
    if (!article?.content) {
      return {
        ok: false, url: finalUrl, title: null, byline: null, siteName: null, publishedTime: null,
        excerpt: null, leadImage: null,
        markdown: { markdown: '', images: [], wordCount: 0 },
        status: 200, error: 'no readable content after render',
      };
    }
    const md = htmlToMarkdown(article.content, finalUrl);
    return {
      ok: true,
      url: finalUrl,
      title: article.title?.trim() || null,
      byline: article.byline?.trim() || null,
      siteName: article.siteName?.trim() || null,
      publishedTime: null,
      excerpt: article.excerpt?.trim() || null,
      leadImage: md.images[0] ?? null,
      markdown: {
        markdown: md.markdown.slice(0, config.ingest.maxContentChars),
        images: md.images,
        wordCount: md.wordCount,
      },
      status: 200,
    };
  } catch (err) {
    return {
      ok: false, url, title: null, byline: null, siteName: null, publishedTime: null,
      excerpt: null, leadImage: null,
      markdown: { markdown: '', images: [], wordCount: 0 },
      status: 0, error: (err as Error).message,
    };
  } finally {
    await browser.close();
  }
}
