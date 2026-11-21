import { describe, it, expect } from 'vitest';
import { classify, detectInstitution, detectCategory, isVerifiable } from '../src/sources/classify.js';
import { titleFingerprint } from '../src/store/articles.js';

const base = {
  excerpt: '',
  content: '',
  defaultCategory: 'Education',
  focus: 'education' as const,
  country: 'Nigeria',
};

describe('classify — relevance', () => {
  it('accepts a Nigerian university story', () => {
    const r = classify({
      ...base,
      title: 'NUC approves 13 new degree programmes for Nigerian universities',
      excerpt: 'The National Universities Commission has accredited the programmes.',
      content: 'The commission said the accreditation follows a resource verification visit.',
    });
    expect(r.relevant).toBe(true);
    expect(r.category).toBe('Accreditation');
  });

  it('rejects casino and betting spam that leaks into education feeds', () => {
    const r = classify({
      ...base,
      title: 'Best slot gacor and togel casino bonuses this week',
      excerpt: 'Sports betting odds and jackpot tips.',
      content: 'Bet9ja and 1xbet promo codes.',
    });
    expect(r.relevant).toBe(false);
  });

  it('rejects an unrelated lifestyle post from a specialist publisher', () => {
    const r = classify({
      ...base,
      title: 'Five fashion trends to try this season',
      excerpt: 'Colour blocking and bold prints are back.',
      content: 'Stylists recommend layering.',
    });
    expect(r.relevant).toBe(false);
  });

  it('applies a stricter bar to general newspapers', () => {
    const r = classify({
      ...base,
      focus: 'general',
      title: 'Governor commissions new road in the state capital',
      excerpt: 'The road links two local government areas.',
      content: 'Residents thanked the governor.',
    });
    expect(r.relevant).toBe(false);
  });

  it('still accepts a real education story from a general newspaper', () => {
    const r = classify({
      ...base,
      focus: 'general',
      title: 'ASUU threatens fresh strike over unpaid allowances',
      excerpt: 'University lecturers say the government has reneged on its agreement.',
      content: 'The academic staff union met in Abuja.',
    });
    expect(r.relevant).toBe(true);
  });

  it('accepts almost anything from an authority source', () => {
    const r = classify({
      ...base,
      focus: 'authority',
      title: 'Press release: TETFund board holds quarterly meeting',
      excerpt: 'The board reviewed intervention projects.',
      content: 'The meeting held in Abuja.',
    });
    expect(r.relevant).toBe(true);
  });

  it('trusts an education feed category for a specialist publisher', () => {
    const r = classify({
      ...base,
      title: 'Elizade University announces acceptance fee',
      excerpt: '',
      content: '',
      feedCategories: ['Admissions'],
    });
    expect(r.relevant).toBe(true);
  });
});

describe('detectCategory', () => {
  const cases: Array<[string, string]> = [
    ['JAMB releases 2026 UTME results', 'Examinations'],
    ['NUC grants full accreditation to engineering programme', 'Accreditation'],
    ['University announces sale of post-UTME form', 'Admissions'],
    ['Fully funded scholarship for Nigerian undergraduates', 'Scholarship'],
    ['TETFund approves N2bn for infrastructure', 'Funding'],
    ['Professor Ada Nwosu appointed vice chancellor', 'Appointments'],
    ['ASUU begins indefinite strike over allowances', 'Policy'],
    ['Researchers publish breakthrough malaria study', 'Research'],
    ['Students union elects new executives on campus', 'Campus'],
  ];

  for (const [title, expected] of cases) {
    it(`classifies "${title.slice(0, 40)}…" as ${expected}`, () => {
      expect(detectCategory(title, 'Education')).toBe(expected);
    });
  }

  it('falls back when nothing matches', () => {
    expect(detectCategory('A quiet week at the ministry', 'Policy')).toBe('Policy');
  });
});

describe('detectInstitution', () => {
  it('finds a known institution by full name', () => {
    expect(detectInstitution('The Federal University of Technology Owerri has released its cut-off marks'))
      .toBe('Federal University of Technology Owerri');
  });

  it('finds a known institution by acronym', () => {
    expect(detectInstitution('FUTO announces resumption date')).toBe('FUTO');
  });

  it('detects an institution not in the known list', () => {
    const found = detectInstitution('Kingsley Ozumba Mbadiwe University matriculates 900 students');
    expect(found).toBe('Kingsley Ozumba Mbadiwe University');
  });

  it('detects a polytechnic', () => {
    expect(detectInstitution('Federal Polytechnic Nekede releases admission list')).toBe('Federal Polytechnic Nekede');
  });

  it('returns null when no institution is named', () => {
    expect(detectInstitution('JAMB announces new registration deadline')).toBeNull();
  });
});

describe('isVerifiable', () => {
  const ok = {
    contentChars: 3000,
    minChars: 400,
    extraction: 'page_full',
    tier: 'national' as const,
    publishedWithinWindow: true,
  };

  it('verifies a full article inside the window', () => {
    expect(isVerifiable(ok)).toBe(true);
  });

  it('rejects an article outside the window', () => {
    expect(isVerifiable({ ...ok, publishedWithinWindow: false })).toBe(false);
  });

  it('rejects thin content', () => {
    expect(isVerifiable({ ...ok, contentChars: 120 })).toBe(false);
  });

  it('rejects an excerpt-only national story', () => {
    expect(isVerifiable({ ...ok, extraction: 'excerpt_only' })).toBe(false);
  });

  it('allows an excerpt-only authority notice', () => {
    expect(isVerifiable({ ...ok, extraction: 'excerpt_only', tier: 'authority' })).toBe(true);
  });
});

describe('titleFingerprint', () => {
  it('matches the same headline with different punctuation and case', () => {
    const a = titleFingerprint('NUC Approves 13 New Degree Programmes!');
    const b = titleFingerprint('nuc approves 13 new degree programmes');
    expect(a).toBe(b);
  });

  it('differs for different headlines', () => {
    expect(titleFingerprint('JAMB releases results')).not.toBe(titleFingerprint('JAMB extends deadline'));
  });

  it('is empty for an empty title', () => {
    expect(titleFingerprint('   ')).toBe('');
  });
});
