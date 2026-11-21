import { describe, it, expect } from 'vitest';
import { canonicalUrl, articleId, hostOf } from '../src/util/hash.js';

describe('canonicalUrl', () => {
  it('strips tracking parameters', () => {
    const url = canonicalUrl('https://punchng.com/university-fees-rise/?utm_source=twitter&utm_medium=social&fbclid=abc');
    expect(url).toBe('https://punchng.com/university-fees-rise');
  });

  it('removes the www prefix and trailing slash', () => {
    expect(canonicalUrl('https://www.premiumtimesng.com/education/story/')).toBe(
      'https://premiumtimesng.com/education/story',
    );
  });

  it('drops fragments', () => {
    expect(canonicalUrl('https://edugist.org/post#comments')).toBe('https://edugist.org/post');
  });

  it('upgrades http to https', () => {
    expect(canonicalUrl('http://myschoolgist.com/news/x')).toBe('https://myschoolgist.com/news/x');
  });

  it('resolves relative URLs against a base', () => {
    expect(canonicalUrl('/news/item-1', 'https://myschool.ng/news')).toBe('https://myschool.ng/news/item-1');
  });

  it('keeps meaningful query parameters and sorts them', () => {
    const a = canonicalUrl('https://example.com/page?b=2&a=1');
    const b = canonicalUrl('https://example.com/page?a=1&b=2');
    expect(a).toBe(b);
  });

  it('treats the same story with different tracking as identical', () => {
    const one = canonicalUrl('https://guardian.ng/news/story?utm_campaign=x');
    const two = canonicalUrl('https://www.guardian.ng/news/story/');
    expect(one).toBe(two);
  });

  it('returns the input unchanged when unparseable', () => {
    expect(canonicalUrl('not a url')).toBe('not a url');
  });
});

describe('articleId', () => {
  it('is deterministic and 16 hex characters', () => {
    const id = articleId('https://example.com/a');
    expect(id).toBe(articleId('https://example.com/a'));
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('differs for different URLs', () => {
    expect(articleId('https://example.com/a')).not.toBe(articleId('https://example.com/b'));
  });
});

describe('hostOf', () => {
  it('normalises the hostname', () => {
    expect(hostOf('https://www.Vanguardngr.com/x')).toBe('vanguardngr.com');
  });

  it('returns empty for junk', () => {
    expect(hostOf('nope')).toBe('');
  });
});
