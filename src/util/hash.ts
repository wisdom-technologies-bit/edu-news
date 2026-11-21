import { createHash } from 'node:crypto';

/** Deterministic SHA-1 hex digest of a string. */
export function sha1(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex');
}

/** Stable short id for an article, derived from its canonical URL. */
export function articleId(canonicalUrl: string): string {
  return sha1(canonicalUrl).slice(0, 16);
}

/**
 * Canonicalise an article URL so the same story is not stored twice:
 * strips tracking params, fragments, trailing slashes and normalises the host.
 */
export function canonicalUrl(raw: string, base?: string): string {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return raw;
  }

  u.hash = '';
  u.protocol = u.protocol === 'http:' ? 'https:' : u.protocol;
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if (u.port === '80' || u.port === '443') u.port = '';

  const drop = new Set([
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'utm_id',
    'fbclid',
    'gclid',
    'mc_cid',
    'mc_eid',
    'ref',
    'oc',
    'amp',
    '_ga',
  ]);
  for (const key of [...u.searchParams.keys()]) {
    if (drop.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
      u.searchParams.delete(key);
    }
  }

  // Sort remaining params for a stable key.
  const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of sorted) u.searchParams.append(k, v);

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  return u.toString();
}

/** Hostname of a URL without a leading www., or '' when unparseable. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}
