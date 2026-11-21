/**
 * Source model for the aggregation layer.
 *
 * Every publisher is described declaratively so that collection behaviour is
 * data, not code. The registry in `registry.ts` is the single place to add a
 * publisher — no changes to the pipeline are needed.
 */

/** How articles are discovered for a source. */
export type DiscoveryKind =
  /** Standard RSS/Atom feed(s). */
  | 'rss'
  /** Scrape a listing page for article links (sites with no usable feed). */
  | 'html-list'
  /** Google News RSS `site:` query (sites that block crawlers). */
  | 'google-news';

/** Where the article body comes from. */
export type ContentStrategy =
  /** Prefer the feed's content:encoded / description when substantial. */
  | 'auto'
  /** Feed body is always full and reliable — never fetch the page. */
  | 'feed'
  /** Feed body is an excerpt — always fetch the article page. */
  | 'page'
  /** Page cannot be fetched (bot protection) — keep the feed excerpt only. */
  | 'excerpt';

/** Editorial tier, used for ranking and for `is_verified`. */
export type SourceTier =
  /** Regulator / government authority — primary source. */
  | 'authority'
  /** Established national newspaper. */
  | 'national'
  /** Education-specialist publisher or campus news site. */
  | 'specialist';

export interface HtmlListConfig {
  /** Listing page to scrape. */
  url: string;
  /** Selector for each card on the listing page. */
  itemSelector: string;
  /** Selector (within the card) for the article link. Defaults to `a`. */
  linkSelector?: string;
  /** Selector (within the card) for the headline. Defaults to the link text. */
  titleSelector?: string;
  /** Selector (within the card) for a date string. */
  dateSelector?: string;
  /** Regex the article URL path must match, to skip navigation links. */
  linkPattern?: string;
}

export interface GoogleNewsConfig {
  /** Queries passed to Google News RSS, already scoped with `site:`. */
  queries: string[];
  /** Hostname the resulting publisher link must belong to. */
  expectedHost: string;
}

export interface SourceDef {
  /** Stable slug, used in API filters and Redis keys. */
  id: string;
  /** Display name returned as `source_name`. */
  name: string;
  homepage: string;
  tier: SourceTier;
  discovery: DiscoveryKind;

  /** RSS/Atom endpoints (first that works is used). */
  feeds?: string[];
  htmlList?: HtmlListConfig;
  googleNews?: GoogleNewsConfig;

  content: ContentStrategy;

  /** Default category when the article itself is ambiguous. */
  defaultCategory: string;

  /**
   * Publisher focus. `general` sources are filtered hard for education
   * relevance; `education` sources are trusted to be on-topic.
   */
  focus: 'education' | 'general' | 'authority';

  /** Country of the publisher (ISO name, as returned by the API). */
  country: string;
  /** ISO-639-1 language of the published text. */
  language: string;

  /** Set when the publisher covers one institution specifically. */
  institution?: string;

  /** Requires the optional headless browser to fetch article pages. */
  needsBrowser?: boolean;

  /** Excluded from collection but kept documented in /api/sources. */
  disabled?: boolean;
  /** Why a source is disabled — surfaced by /api/sources. */
  disabledReason?: string;

  /** Free-form notes shown in the docs and /api/sources. */
  notes?: string;
}

/** Google News discovery queries, run as an extra pass over all publishers. */
export interface DiscoveryQuery {
  id: string;
  query: string;
  category?: string;
}

export const DISCOVERY_QUERIES: DiscoveryQuery[] = [
  { id: 'gn-university', query: 'Nigeria university news' },
  { id: 'gn-polytechnic', query: 'Nigeria polytechnic news' },
  { id: 'gn-tertiary', query: 'Nigeria tertiary education' },
  { id: 'gn-lecturers', query: 'Nigerian university lecturers' },
  { id: 'gn-asuu', query: 'ASUU news Nigeria' },
  { id: 'gn-admissions', query: 'Nigerian university admissions', category: 'Admissions' },
  { id: 'gn-research', query: 'Nigerian university research', category: 'Research' },
  { id: 'gn-campus', query: 'Nigerian campus news', category: 'Campus' },
  { id: 'gn-nuc', query: 'NUC accreditation Nigeria', category: 'Accreditation' },
  { id: 'gn-convocation', query: 'Nigerian university convocation', category: 'Campus' },
];
