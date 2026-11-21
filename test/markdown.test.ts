import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, firstImage, tidyMarkdown } from '../src/ingest/markdown.js';

describe('htmlToMarkdown', () => {
  it('keeps headings, emphasis and lists', () => {
    const md = htmlToMarkdown(
      '<h2>New programme</h2><p>The <strong>Senate</strong> approved <em>two</em> courses.</p><ul><li>First</li><li>Second</li></ul>',
      'https://example.com/article',
    ).markdown;

    expect(md).toContain('## New programme');
    expect(md).toContain('**Senate**');
    expect(md).toContain('_two_');
    expect(md).toMatch(/-\s+First/);
    expect(md).toMatch(/-\s+Second/);
  });

  it('converts images and absolutises their URLs', () => {
    const md = htmlToMarkdown(
      '<p>Intro</p><img src="/wp-content/uploads/photo.jpg" alt="Campus gate">',
      'https://myschoolgist.com/news/story/',
    ).markdown;

    expect(md).toContain('![Campus gate](https://myschoolgist.com/wp-content/uploads/photo.jpg)');
  });

  it('resolves lazy-loaded images from data-src', () => {
    const md = htmlToMarkdown(
      '<img src="data:image/gif;base64,R0lGOD" data-src="https://cdn.example.com/real.jpg" alt="Lecture hall">',
      'https://example.com/a',
    ).markdown;

    expect(md).toContain('https://cdn.example.com/real.jpg');
    expect(md).not.toContain('data:image/gif');
  });

  it('picks the highest-resolution candidate from srcset', () => {
    const md = htmlToMarkdown(
      '<img srcset="https://cdn.example.com/s.jpg 400w, https://cdn.example.com/l.jpg 1200w" alt="Hall">',
      'https://example.com/a',
    ).markdown;

    expect(md).toContain('https://cdn.example.com/l.jpg');
  });

  it('drops tracking pixels', () => {
    const md = htmlToMarkdown(
      '<p>Body</p><img src="https://pixel.wp.com/g.gif?v=1" width="1" height="1">',
      'https://example.com/a',
    ).markdown;

    expect(md).not.toContain('pixel.wp.com');
  });

  it('keeps a figure caption as italic text', () => {
    const md = htmlToMarkdown(
      '<figure><img src="https://cdn.example.com/x.jpg" alt="VC"><figcaption>Prof. Ada Nwosu, Vice Chancellor</figcaption></figure>',
      'https://example.com/a',
    ).markdown;

    expect(md).toContain('![VC](https://cdn.example.com/x.jpg)');
    expect(md).toContain('*Prof. Ada Nwosu, Vice Chancellor*');
  });

  it('strips scripts, styles and share widgets', () => {
    const md = htmlToMarkdown(
      '<p>Keep this</p><script>alert(1)</script><style>.x{}</style><div class="sharedaddy">Share on X</div>',
      'https://example.com/a',
    ).markdown;

    expect(md).toContain('Keep this');
    expect(md).not.toContain('alert(1)');
    expect(md).not.toContain('Share on X');
  });

  it('absolutises links and unwraps javascript: hrefs', () => {
    const md = htmlToMarkdown(
      '<p><a href="/apply">Apply now</a> or <a href="javascript:void(0)">click</a></p>',
      'https://example.com/news/',
    ).markdown;

    expect(md).toContain('[Apply now](https://example.com/apply)');
    expect(md).not.toContain('javascript:');
  });

  it('preserves blockquotes and tables', () => {
    const md = htmlToMarkdown(
      '<blockquote><p>Quoted line</p></blockquote><table><thead><tr><th>Course</th><th>Cut-off</th></tr></thead><tbody><tr><td>Medicine</td><td>280</td></tr></tbody></table>',
      'https://example.com/a',
    ).markdown;

    expect(md).toContain('> Quoted line');
    expect(md).toContain('| Course |');
    expect(md).toContain('| Medicine |');
  });

  it('counts words and collects image URLs', () => {
    const result = htmlToMarkdown(
      '<p>One two three four five</p><img src="https://cdn.example.com/a.jpg" alt="A">',
      'https://example.com/a',
    );
    expect(result.wordCount).toBeGreaterThanOrEqual(5);
    expect(result.images).toEqual(['https://cdn.example.com/a.jpg']);
  });

  it('returns an empty result for empty input', () => {
    expect(htmlToMarkdown('', 'https://example.com').markdown).toBe('');
  });
});

describe('tidyMarkdown', () => {
  it('collapses runs of blank lines', () => {
    expect(tidyMarkdown('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('drops unresolved relative images', () => {
    expect(tidyMarkdown('text\n\n![x](/local.jpg)\n\nmore')).not.toContain('/local.jpg');
  });
});

describe('firstImage', () => {
  it('finds the first absolute image', () => {
    expect(firstImage('intro\n\n![a](https://cdn.example.com/one.jpg)\n\n![b](https://cdn.example.com/two.jpg)')).toBe(
      'https://cdn.example.com/one.jpg',
    );
  });

  it('returns null when there is no image', () => {
    expect(firstImage('just text')).toBeNull();
  });
});

describe('tidyMarkdown — duplicate images', () => {
  it('collapses the same image repeated back to back', () => {
    const out = tidyMarkdown(
      '![A](https://cdn.example.com/a.jpg)\n\n![A](https://cdn.example.com/a.jpg)\n\nBody text',
    );
    expect(out.match(/a\.jpg/g)).toHaveLength(1);
    expect(out).toContain('Body text');
  });

  it('collapses three identical images in a row', () => {
    const one = '![A](https://cdn.example.com/a.jpg)';
    const out = tidyMarkdown(`${one}\n\n${one}\n\n${one}\n\nBody`);
    expect(out.match(/a\.jpg/g)).toHaveLength(1);
  });

  it('keeps genuinely different images in sequence', () => {
    const out = tidyMarkdown(
      '![A](https://cdn.example.com/a.jpg)\n\n![B](https://cdn.example.com/b.jpg)',
    );
    expect(out).toContain('a.jpg');
    expect(out).toContain('b.jpg');
  });

  it('keeps the same image when it recurs later in the article', () => {
    const out = tidyMarkdown(
      '![A](https://cdn.example.com/a.jpg)\n\nA long paragraph of body text.\n\n![A](https://cdn.example.com/a.jpg)',
    );
    expect(out.match(/a\.jpg/g)).toHaveLength(2);
  });
});
