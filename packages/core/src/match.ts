import {
  normalizeAsin,
  normalizeIsbn,
  normalizePeople,
  normalizeSeries,
  normalizeTitle,
  parseSequence,
} from './normalize';
import { ratio, titleSimilarity, tokenSetRatio } from './similarity';
import type { BookRecord, MatchResult, MatchTier, ScoredMatch } from './types';

export interface MatchOptions {
  /** At/above this score two books are treated as definitely the same work. */
  strongThreshold: number;
  /** At/above this score the pair is a candidate but flagged for review. */
  fuzzyThreshold: number;
  /** Minimum title similarity required before any fuzzy match is considered. */
  titleGate: number;
  /** Relative duration difference treated as "same recording" (0.10 = 10%). */
  durationTolerance: number;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  strongThreshold: 0.9,
  fuzzyThreshold: 0.78,
  titleGate: 0.72,
  durationTolerance: 0.1,
};

/** Precomputed comparison form of a book. Building this is the expensive part. */
export interface BookIdentity {
  book: BookRecord;
  titleNorm: string;
  titleBase: string;
  titleNoPossessive: string;
  /**
   * Whether the variant forms are actually distinct from `titleNorm`. Most
   * titles have no subtitle and no possessive, so all three forms are the same
   * string; knowing that up front skips redundant edit-distance work on the hot
   * path, where a single diff scores hundreds of thousands of pairs.
   */
  titleBaseDiffers: boolean;
  titleNoPossessiveDiffers: boolean;
  /** Volume/part numbers extracted from the title. */
  numbers: number[];
  authors: string[];
  narrators: string[];
  /** Normalized series name -> numeric sequence (null when non-numeric). */
  series: Map<string, number | null>;
  asin: string | null;
  isbn: string | null;
  durationSec: number | null;
}

export function deriveIdentity(book: BookRecord): BookIdentity {
  const title = normalizeTitle(book.title, book.subtitle ?? null);
  const series = new Map<string, number | null>();
  for (const ref of book.series ?? []) {
    const name = normalizeSeries(ref.name);
    if (name) series.set(name, parseSequence(ref.sequence ?? null));
  }
  return {
    book,
    titleNorm: title.norm,
    titleBase: title.base,
    titleNoPossessive: title.noPossessive,
    titleBaseDiffers: title.base !== title.norm,
    titleNoPossessiveDiffers: title.noPossessive !== title.norm && title.noPossessive !== title.base,
    numbers: title.numbers,
    authors: normalizePeople(book.authors ?? []),
    narrators: normalizePeople(book.narrators ?? []),
    series,
    asin: normalizeAsin(book.asin ?? null),
    isbn: normalizeIsbn(book.isbn ?? null),
    durationSec: book.durationSec && book.durationSec > 0 ? book.durationSec : null,
  };
}

/**
 * Similarity between two author/narrator lists.
 *
 * Compares pairwise, then also compares the two lists flattened into one token
 * bag. The flattened pass matters because servers disagree about how to split
 * names: one may report `["Sanderson", "Brandon"]` where another reports
 * `["Brandon Sanderson"]`, which scores poorly pairwise but is clearly the same
 * person once tokenized.
 */
function bestNameSimilarity(a: string[], b: string[]): number | null {
  if (a.length === 0 || b.length === 0) return null;

  let best = 0;
  for (const x of a) {
    for (const y of b) {
      if (x === y) return 1;
      const score = ratio(x, y);
      if (score > best) best = score;
    }
  }

  const flattened = tokenSetRatio(a.join(' '), b.join(' '));
  return Math.max(best, flattened);
}

/**
 * Largest duration multiple treated as a metadata artifact rather than evidence.
 */
const MAX_ARTIFACT_MULTIPLE = 4;
/** How close to a whole multiple counts as "exactly N times longer". */
const MULTIPLE_EPSILON = 0.02;

function durationSimilarity(a: number | null, b: number | null, tolerance: number): number | null {
  if (!a || !b) return null;
  const longer = Math.max(a, b);
  const shorter = Math.min(a, b);
  const rel = (longer - shorter) / longer;
  if (rel <= tolerance) return 1;

  // Audiobookshelf reports an item's duration as an exact multiple of the truth
  // when `media.audioFiles` has accumulated stale duplicate entries — the same
  // files counted twice. On a real 2.35.1 server this affected 88% of one
  // library, every one of them doubled. A near-exact whole-number ratio is
  // therefore far more likely to be that artifact than genuine evidence of a
  // different recording, so withhold the duration signal instead of scoring it
  // as a mismatch and pushing a book the target already owns into "missing".
  const multiple = longer / shorter;
  const nearest = Math.round(multiple);
  if (nearest >= 2 && nearest <= MAX_ARTIFACT_MULTIPLE && Math.abs(multiple - nearest) <= MULTIPLE_EPSILON) {
    return null;
  }

  // Decay to zero by the time the difference reaches tolerance + 50%.
  return Math.max(0, 1 - (rel - tolerance) / 0.5);
}

/**
 * Best similarity across the title variants, skipping comparisons that would
 * repeat an identical pair of strings.
 *
 * The variants exist because catalogues disagree about whether the subtitle is
 * part of the title and whether a possessive is included at all. The cross
 * comparisons cover one server storing the subtitle where the other does not.
 */
function bestTitleSimilarity(a: BookIdentity, b: BookIdentity): number {
  let best = titleSimilarity(a.titleNorm, b.titleNorm);
  if (best === 1) return 1;

  if (a.titleBaseDiffers || b.titleBaseDiffers) {
    best = Math.max(best, titleSimilarity(a.titleBase, b.titleBase));
    if (b.titleBaseDiffers) best = Math.max(best, titleSimilarity(a.titleNorm, b.titleBase));
    if (a.titleBaseDiffers) best = Math.max(best, titleSimilarity(a.titleBase, b.titleNorm));
    if (best === 1) return 1;
  }

  if (a.titleNoPossessiveDiffers || b.titleNoPossessiveDiffers) {
    best = Math.max(best, titleSimilarity(a.titleNoPossessive, b.titleNoPossessive));
  }

  return best;
}

/**
 * Returns true when the two identities carry contradictory volume information.
 * This is a hard reject rather than a score penalty: "Part 1" and "Part 2" of
 * the same release are otherwise near-identical on every other signal, and a
 * false merge makes the diff engine claim you already own a book you don't.
 */
function hasVolumeConflict(a: BookIdentity, b: BookIdentity): string | null {
  if (a.numbers.length > 0 && b.numbers.length > 0) {
    const shared = a.numbers.some((n) => b.numbers.includes(n));
    if (!shared) return `title volume numbers differ (${a.numbers.join('/')} vs ${b.numbers.join('/')})`;
  }
  for (const [name, seqA] of a.series) {
    const seqB = b.series.get(name);
    if (seqB === undefined) continue;
    if (seqA !== null && seqB !== null && seqA !== seqB) {
      return `series "${name}" sequence differs (${seqA} vs ${seqB})`;
    }
  }
  return null;
}

/**
 * Scores two books as candidates for being the same work.
 * Returns null when they should not be considered a match at all.
 */
export function scoreIdentities(
  a: BookIdentity,
  b: BookIdentity,
  options: MatchOptions = DEFAULT_MATCH_OPTIONS,
): MatchResult | null {
  // Hard identifiers win outright — but still respect volume conflicts, since a
  // shared ASIN across differing volumes indicates bad upstream metadata.
  const conflict = hasVolumeConflict(a, b);

  if (a.asin && b.asin && a.asin === b.asin && !conflict) {
    return { score: 1, tier: 'asin', reasons: [`identical ASIN ${a.asin}`] };
  }
  if (a.isbn && b.isbn && a.isbn === b.isbn && !conflict) {
    return { score: 0.995, tier: 'isbn', reasons: [`identical ISBN ${a.isbn}`] };
  }
  if (conflict) return null;

  const titleSim = bestTitleSimilarity(a, b);
  if (titleSim < options.titleGate) return null;

  const authorSim = bestNameSimilarity(a.authors, b.authors);
  const durationSim = durationSimilarity(a.durationSec, b.durationSec, options.durationTolerance);

  const parts: Array<{ weight: number; value: number }> = [{ weight: 0.55, value: titleSim }];
  if (authorSim !== null) parts.push({ weight: 0.3, value: authorSim });
  if (durationSim !== null) parts.push({ weight: 0.15, value: durationSim });

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  let score = parts.reduce((sum, p) => sum + p.weight * p.value, 0) / totalWeight;

  // A shared series+sequence is strong corroboration.
  let sharedSeries: string | null = null;
  for (const [name, seqA] of a.series) {
    const seqB = b.series.get(name);
    if (seqB !== undefined && seqA !== null && seqA === seqB) {
      sharedSeries = name;
      break;
    }
  }
  if (sharedSeries) score = Math.min(1, score + 0.04);

  // An author mismatch on an otherwise-identical title usually means different
  // works sharing a common title ("Beloved", "Blink"). Penalize hard.
  if (authorSim !== null && authorSim < 0.6) score -= 0.2;

  const reasons: string[] = [`title ${(titleSim * 100).toFixed(0)}%`];
  if (authorSim !== null) reasons.push(`author ${(authorSim * 100).toFixed(0)}%`);
  if (durationSim !== null) reasons.push(`duration ${(durationSim * 100).toFixed(0)}%`);
  if (sharedSeries) reasons.push(`same series position (${sharedSeries})`);

  let tier: MatchTier;
  if (titleSim === 1 && authorSim === 1) tier = 'exact';
  else if (score >= options.strongThreshold) tier = 'strong';
  else if (score >= options.fuzzyThreshold) tier = 'fuzzy';
  else return null;

  return { score: Math.max(0, Math.min(1, score)), tier, reasons };
}

/** Tiers that mean "this is the same book, no human review needed". */
const CONFIDENT_TIERS: ReadonlySet<MatchTier> = new Set<MatchTier>(['asin', 'isbn', 'exact', 'strong']);

export function isConfident(match: MatchResult): boolean {
  return CONFIDENT_TIERS.has(match.tier);
}

/** Max candidates scored per lookup, to keep large libraries responsive. */
const MAX_CANDIDATES = 400;
/** Buckets bigger than this are skipped when better-discriminating keys exist. */
const WIDE_BUCKET = 1500;

function blockingKeys(identity: BookIdentity): string[] {
  const keys = new Set<string>();
  for (const source of [identity.titleNorm, identity.titleBase]) {
    for (const token of source.split(' ')) {
      if (token.length >= 4) keys.add(`t:${token}`);
    }
  }
  // Short-title fallback ("Dune", "It"): block on the whole title.
  if (keys.size === 0 && identity.titleNorm) keys.add(`w:${identity.titleNorm}`);
  for (const author of identity.authors) keys.add(`a:${author}`);
  for (const series of identity.series.keys()) keys.add(`s:${series}`);
  return [...keys];
}

/**
 * Inverted index over a set of books supporting "does this collection already
 * contain this work?" queries. Built once per diff, reused across all sources.
 */
export class BookIndex {
  private readonly byAsin = new Map<string, BookIdentity[]>();
  private readonly byIsbn = new Map<string, BookIdentity[]>();
  private readonly byBlock = new Map<string, BookIdentity[]>();
  private readonly identities: BookIdentity[] = [];

  constructor(books: Iterable<BookRecord> = []) {
    for (const book of books) this.add(book);
  }

  get size(): number {
    return this.identities.length;
  }

  all(): readonly BookIdentity[] {
    return this.identities;
  }

  add(book: BookRecord): BookIdentity {
    const identity = deriveIdentity(book);
    this.addIdentity(identity);
    return identity;
  }

  addIdentity(identity: BookIdentity): void {
    this.identities.push(identity);
    if (identity.asin) push(this.byAsin, identity.asin, identity);
    if (identity.isbn) push(this.byIsbn, identity.isbn, identity);
    for (const key of blockingKeys(identity)) push(this.byBlock, key, identity);
  }

  private candidates(identity: BookIdentity): BookIdentity[] {
    const seen = new Map<BookIdentity, number>();
    const consider = (list: BookIdentity[] | undefined, weight: number) => {
      if (!list) return;
      for (const candidate of list) {
        if (candidate === identity) continue;
        seen.set(candidate, (seen.get(candidate) ?? 0) + weight);
      }
    };

    // Hard identifiers first — these are cheap and decisive.
    if (identity.asin) consider(this.byAsin.get(identity.asin), 100);
    if (identity.isbn) consider(this.byIsbn.get(identity.isbn), 100);

    const keys = blockingKeys(identity);
    const narrow = keys.filter((k) => (this.byBlock.get(k)?.length ?? 0) <= WIDE_BUCKET);
    // Only fall back to wide buckets when nothing narrower exists, so a common
    // word never drags in the entire library.
    for (const key of narrow.length > 0 ? narrow : keys) {
      consider(this.byBlock.get(key), 1);
    }

    if (seen.size <= MAX_CANDIDATES) return [...seen.keys()];
    // Prefer candidates sharing the most blocking keys.
    return [...seen.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, MAX_CANDIDATES)
      .map(([candidate]) => candidate);
  }

  /** Best match for `book` within this index, or null if nothing qualifies. */
  findBest(
    book: BookRecord | BookIdentity,
    options: MatchOptions = DEFAULT_MATCH_OPTIONS,
  ): ScoredMatch | null {
    const identity = 'book' in book ? book : deriveIdentity(book);
    let best: ScoredMatch | null = null;
    for (const candidate of this.candidates(identity)) {
      const match = scoreIdentities(identity, candidate, options);
      if (!match) continue;
      if (!best || match.score > best.score) {
        best = { ...match, candidate: candidate.book };
        // Nothing can beat a hard-identifier match.
        if (match.tier === 'asin') break;
      }
    }
    return best;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
