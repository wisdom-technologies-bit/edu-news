/** A candidate article discovered from a source, before extraction. */
export interface RawItem {
  sourceId: string;
  /** Article URL as published (will be canonicalised later). */
  url: string;
  title: string;
  publishedAt: Date | null;
  /** Feed summary / description (may contain HTML). */
  feedSummary: string;
  /** Feed full body from content:encoded / Atom content (may contain HTML). */
  feedContent: string;
  /** Feed-provided categories and tags. */
  feedCategories: string[];
  /** Image URL from enclosure / media:thumbnail / og:image in the feed. */
  enclosureImage: string | null;
  /** Author as declared by the feed. */
  author: string | null;
}

export interface DiscoverResult {
  sourceId: string;
  items: RawItem[];
  ok: boolean;
  error?: string;
  /** HTTP status of the underlying request, for /api/sources health. */
  status: number;
  durationMs: number;
  /** True when the source responded 304 Not Modified. */
  notModified: boolean;
  etag?: string;
  lastModified?: string;
}
