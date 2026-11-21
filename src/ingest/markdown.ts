import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/**
 * HTML → Markdown conversion that preserves the publisher's own formatting:
 * headings, emphasis, lists, quotes, tables, links, embeds and images.
 *
 * Images are the fiddly part on Nigerian news sites, so this module resolves
 * lazy-loaded sources, absolutises URLs, drops tracking pixels and keeps
 * captions as italic text under the image.
 */

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });

  td.use(gfm);

  // Keep <figure> semantics: image, then caption on its own line.
  td.addRule('figure', {
    filter: 'figure',
    replacement: (_content, node) => {
      const el = node as unknown as HTMLElement;
      const img = el.querySelector('img');
      const caption = el.querySelector('figcaption')?.textContent?.trim();
      const parts: string[] = [];
      if (img) {
        const src = img.getAttribute('src') ?? '';
        const alt = (img.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
        if (src) parts.push(`![${alt}](${src})`);
      }
      if (caption) parts.push(`*${caption}*`);
      return parts.length ? `\n\n${parts.join('\n\n')}\n\n` : '';
    },
  });

  // Videos and audio embeds keep a link so the reader can follow them.
  td.addRule('iframe', {
    filter: 'iframe',
    replacement: (_content, node) => {
      const src = (node as unknown as HTMLElement).getAttribute('src') ?? '';
      if (!src) return '';
      if (/youtube|youtu\.be|vimeo/i.test(src)) return `\n\n[Embedded video](${src})\n\n`;
      return '';
    },
  });

  // Bare <img> outside a figure.
  td.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as unknown as HTMLElement;
      const src = el.getAttribute('src') ?? '';
      if (!src) return '';
      const alt = (el.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
      return `\n\n![${alt}](${src})\n\n`;
    },
  });

  return td;
}

const turndown = createTurndown();

/** Attributes commonly used by lazy-loading plugins. */
const LAZY_SRC_ATTRS = [
  'data-src', 'data-lazy-src', 'data-original', 'data-orig-file', 'data-url',
  'data-lazy', 'data-image', 'data-hi-res-src', 'data-full-src',
];

const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset', 'srcset'];

const TRACKING_PATTERNS = [
  /pixel\.wp\.com/i, /stats\.wp\.com/i, /feeds\.feedburner/i, /doubleclick/i,
  /google-analytics/i, /googletagmanager/i, /facebook\.com\/tr/i, /\/1x1\./i,
  /spacer\.gif/i, /blank\.gif/i, /transparent\.png/i, /gravatar\.com/i,
];

const JUNK_SELECTORS = [
  'script', 'style', 'noscript', 'iframe[src*="doubleclick"]',
  '.sharedaddy', '.jp-relatedposts', '.sd-sharing', '.addtoany_share_save_container',
  '.social-share', '.share-buttons', '.related-posts', '.newsletter-signup',
  '.advertisement', '.ad-container', '.adsbygoogle', '.OUTBRAIN', '.taboola',
  '[class*="newsletter"]', '[class*="subscribe"]', '[id*="taboola"]',
  'form', 'button', 'nav', 'footer', 'aside[role="complementary"]',
];

function absolute(url: string, base: string): string {
  if (!url) return '';
  const cleaned = url.trim();
  if (cleaned.startsWith('data:')) return '';
  try {
    return new URL(cleaned, base).toString();
  } catch {
    return '';
  }
}

/** Choose the highest-resolution candidate from a srcset string. */
function bestFromSrcset(srcset: string, base: string): string {
  const candidates = srcset
    .split(',')
    .map((part) => part.trim().split(/\s+/))
    .filter((p) => p[0])
    .map((p) => {
      const descriptor = p[1] ?? '';
      let weight = 1;
      if (descriptor.endsWith('w')) weight = Number.parseInt(descriptor, 10) || 1;
      else if (descriptor.endsWith('x')) weight = (Number.parseFloat(descriptor) || 1) * 1000;
      return { url: p[0], weight };
    })
    .sort((a, b) => b.weight - a.weight);
  return candidates.length ? absolute(candidates[0].url, base) : '';
}

/**
 * Normalise the DOM of an article body before conversion:
 * resolve lazy images, absolutise links, strip junk, drop tracking pixels.
 */
export function prepareHtml(html: string, baseUrl: string): string {
  const $ = cheerio.load(html);

  for (const selector of JUNK_SELECTORS) {
    try {
      $(selector).remove();
    } catch {
      /* invalid selector on a particular DOM — skip it */
    }
  }

  $('img').each((_, el) => {
    const img = $(el);

    let src = img.attr('src') ?? '';
    // Prefer the highest-resolution lazy attribute when src is a placeholder.
    for (const attr of LAZY_SRC_ATTRS) {
      const candidate = img.attr(attr);
      if (candidate && (!src || src.startsWith('data:') || TRACKING_PATTERNS.some((p) => p.test(src)))) {
        src = candidate;
        break;
      }
    }
    if (!src || src.startsWith('data:')) {
      for (const attr of LAZY_SRCSET_ATTRS) {
        const candidate = img.attr(attr);
        if (candidate) {
          const best = bestFromSrcset(candidate, baseUrl);
          if (best) {
            src = best;
            break;
          }
        }
      }
    }

    const resolved = absolute(src, baseUrl);
    if (!resolved || TRACKING_PATTERNS.some((p) => p.test(resolved))) {
      img.remove();
      return;
    }

    // Drop obvious 1px spacers.
    const w = Number.parseInt(img.attr('width') ?? '', 10);
    const h = Number.parseInt(img.attr('height') ?? '', 10);
    if ((w && w <= 2) || (h && h <= 2)) {
      img.remove();
      return;
    }

    img.attr('src', resolved);
    img.removeAttr('srcset');
    img.removeAttr('loading');
    for (const attr of LAZY_SRC_ATTRS) img.removeAttr(attr);
    if (!img.attr('alt')) img.attr('alt', '');
  });

  $('a').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    if (!href) return;
    if (href.startsWith('#') || href.startsWith('javascript:')) {
      a.replaceWith(a.text());
      return;
    }
    const resolved = absolute(href, baseUrl);
    if (resolved) a.attr('href', resolved);
    else a.removeAttr('href');
  });

  // Strip inline event handlers and styles.
  $('*').each((_, el) => {
    const node = $(el);
    const attribs = (el as unknown as { attribs?: Record<string, string> }).attribs ?? {};
    for (const name of Object.keys(attribs)) {
      if (name.startsWith('on') || name === 'style' || name.startsWith('data-')) {
        if (name === 'data-src' || name === 'data-lazy-src') continue;
        node.removeAttr(name);
      }
    }
  });

  return $('body').html() ?? html;
}

export interface MarkdownResult {
  markdown: string;
  images: string[];
  wordCount: number;
}

/** Convert an HTML fragment to Markdown, preserving formatting and images. */
export function htmlToMarkdown(html: string, baseUrl: string): MarkdownResult {
  if (!html || !html.trim()) return { markdown: '', images: [], wordCount: 0 };

  const prepared = prepareHtml(html, baseUrl);
  let markdown = turndown.turndown(prepared);

  markdown = tidyMarkdown(markdown);

  const images = [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]);
  const wordCount = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>`\-|]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;

  return { markdown, images: [...new Set(images)], wordCount };
}

/**
 * Remove runs of the same image repeated back to back.
 *
 * WordPress feeds commonly put the featured image both in a <figure> and again
 * as the first <img> of the body, so the converter legitimately sees it twice.
 * Only *adjacent* duplicates are collapsed, which keeps real galleries intact.
 */
function collapseAdjacentDuplicateImages(md: string): string {
  const duplicatePair =
    /(!\[[^\]]*\]\((https?:[^)\s]+)\))(?:[ \t]*\n[ \t]*)+(!\[[^\]]*\]\(\2\))/;
  let out = md;
  // Repeat because a URL can appear three or more times in a row.
  for (let i = 0; i < 5 && duplicatePair.test(out); i++) {
    out = out.replace(duplicatePair, '$1');
  }
  return out;
}

/** Collapse the whitespace artefacts Turndown leaves behind. */
export function tidyMarkdown(md: string): string {
  const normalised = md
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
    .replace(/!\[([^\]]*)\]\((?!https?:)[^)]*\)/g, '') // drop unresolved relative images
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return collapseAdjacentDuplicateImages(normalised)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** First real image in a Markdown body. */
export function firstImage(markdown: string): string | null {
  const m = markdown.match(/!\[[^\]]*\]\((https?:[^)\s]+)/);
  return m ? m[1] : null;
}
