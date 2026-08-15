/**
 * Canonical, server-agnostic book shape used by the matching engine, the diff
 * engine and the database. Deliberately decoupled from Audiobookshelf's own
 * response shapes so that mapping quirks stay isolated in @abs-sync/abs-client.
 */
export interface SeriesRef {
  /** Series name as reported by the source server. */
  name: string;
  /** Raw sequence string ("1", "1.5", "2"); ABS allows non-numeric values. */
  sequence?: string | null;
}

export interface BookRecord {
  /** Stable identity within our index: `${serverId}:${itemId}`. */
  key: string;
  serverId: string;
  libraryId: string;
  itemId: string;

  title: string;
  subtitle?: string | null;
  authors: string[];
  narrators: string[];
  series: SeriesRef[];

  asin?: string | null;
  isbn?: string | null;
  publishedYear?: string | null;
  /**
   * Full release date as the source spells it, usually ISO ("2026-03-14").
   * Kept alongside `publishedYear` rather than replacing it: servers populate
   * one, the other, or neither, and ordering by release wants the finest
   * granularity on offer.
   */
  publishedDate?: string | null;
  publisher?: string | null;
  language?: string | null;

  /** Total audio duration in seconds, when the item has audio. */
  durationSec?: number | null;
  /** Total size of the item's files in bytes. */
  sizeBytes?: number | null;
  numAudioFiles?: number | null;

  hasAudio: boolean;
  hasEbook: boolean;
  explicit?: boolean;

  /**
   * Source-side timestamps, epoch millis. All three are kept because servers
   * only sort reliably by some of them, and incremental indexing must compare
   * against whichever field it sorted by — not a preferred one.
   */
  updatedAt?: number | null;
  /** Filesystem mtime. Changes when the item's files change. */
  mtimeMs?: number | null;
  /** When the item was added to the library. */
  addedAt?: number | null;
}

/** How two books were determined to be the same work. */
export type MatchTier = 'asin' | 'isbn' | 'exact' | 'strong' | 'fuzzy';

export interface MatchResult {
  /** 0..1 confidence. */
  score: number;
  tier: MatchTier;
  /** Human-readable justifications, surfaced in the UI. */
  reasons: string[];
  /**
   * Set when the pair is the same *work* but looks like a different *recording*
   * — a different narrator, or a runtime too far apart to be the same reading.
   *
   * Deliberately reported rather than folded into `score`, because the two
   * questions the engine answers want opposite treatment. "Do I already own
   * this?" should say yes for a different narration; "are these two source
   * copies interchangeable?" must say no. Scoring it would conflate them and
   * push books you own into `missing`.
   */
  editionConflict: string | null;
}

export interface ScoredMatch<T = BookRecord> extends MatchResult {
  candidate: T;
}
