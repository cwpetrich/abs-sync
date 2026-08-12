import {
  BookIndex,
  DEFAULT_MATCH_OPTIONS,
  deriveIdentity,
  isConfident,
  type BookIdentity,
  type MatchOptions,
} from './match';
import { normalizePerson, normalizeSeries } from './normalize';
import type { BookRecord, ScoredMatch } from './types';

export interface DiffOptions extends MatchOptions {
  /** Ignore source items that have no audio files (ebook-only entries). */
  requireAudio: boolean;
}

export const DEFAULT_DIFF_OPTIONS: DiffOptions = {
  ...DEFAULT_MATCH_OPTIONS,
  requireAudio: true,
};

/**
 * A work the target library appears to be missing, together with every source
 * server that can supply it. Copies are clustered so the same book offered by
 * three friends shows up as one row with three download options.
 */
export interface MissingBook {
  /** Stable within a single diff run; derived from the representative copy. */
  id: string;
  representative: BookRecord;
  copies: BookRecord[];
  /**
   * `missing` = nothing on the target resembled this.
   * `uncertain` = a weak match exists; likely already owned, needs a human look.
   */
  status: 'missing' | 'uncertain';
  /** The closest thing the target already has, when status is `uncertain`. */
  nearestTargetMatch: ScoredMatch | null;
}

export interface DiffStats {
  sourceTotal: number
  /** Source items skipped because they had no audio and requireAudio was set. */
  skippedNoAudio: number;
  present: number;
  missing: number;
  uncertain: number;
  /** Sum of sizeBytes over representative copies of missing books. */
  missingBytes: number;
}

export interface DiffResult {
  missing: MissingBook[];
  stats: DiffStats;
}

/**
 * Picks the copy most worth downloading: longest duration wins (usually means
 * unabridged over abridged), then largest file size, then most audio files.
 */
export function pickBestCopy(copies: readonly BookRecord[]): BookRecord {
  const sorted = [...copies].sort((a, b) => {
    if (a.hasAudio !== b.hasAudio) return a.hasAudio ? -1 : 1;
    const durA = a.durationSec ?? 0;
    const durB = b.durationSec ?? 0;
    if (Math.abs(durA - durB) > 60) return durB - durA;
    const sizeA = a.sizeBytes ?? 0;
    const sizeB = b.sizeBytes ?? 0;
    if (sizeA !== sizeB) return sizeB - sizeA;
    return (b.numAudioFiles ?? 0) - (a.numAudioFiles ?? 0);
  });
  return sorted[0]!;
}

/** Items processed between cooperative yields in the async driver. */
const DEFAULT_YIELD_EVERY = 25;

/** Hands control back to the host's event loop without blocking it. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/**
 * Computes what `sources` have that `target` lacks.
 *
 * `target` is your own library; `sources` are the pooled items from every
 * server you are comparing against.
 *
 * Fully synchronous. On a 1,338-book library this occupies the thread for about
 * three seconds, so a server rendering a page should prefer
 * `diffAgainstTargetAsync` — see the note there.
 */
export function diffAgainstTarget(
  sources: readonly BookRecord[],
  target: readonly BookRecord[],
  options: DiffOptions = DEFAULT_DIFF_OPTIONS,
): DiffResult {
  const steps = diffSteps(sources, target, options, 0);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * As `diffAgainstTarget`, but pauses periodically so the caller's event loop
 * keeps turning.
 *
 * This matters more than it looks. The diff is a tight synchronous loop of
 * edit-distance comparisons, and a single-threaded server running it blocks
 * completely: it cannot flush a streaming response, serve another request, or
 * write transfer progress until the whole thing finishes. Suspense boundaries
 * are no help against that — there is no thread left to deliver the fallback
 * with. Yielding costs a fraction of a percent and keeps the process responsive.
 */
export async function diffAgainstTargetAsync(
  sources: readonly BookRecord[],
  target: readonly BookRecord[],
  options: DiffOptions = DEFAULT_DIFF_OPTIONS,
  yieldEvery: number = DEFAULT_YIELD_EVERY,
): Promise<DiffResult> {
  const steps = diffSteps(sources, target, options, yieldEvery);
  let step = steps.next();
  while (!step.done) {
    await yieldToEventLoop();
    step = steps.next();
  }
  return step.value;
}

/**
 * The diff itself, expressed as a generator so both drivers above share one
 * implementation. Yields every `yieldEvery` items; 0 means never.
 */
function* diffSteps(
  sources: readonly BookRecord[],
  target: readonly BookRecord[],
  options: DiffOptions,
  yieldEvery: number,
): Generator<void, DiffResult, void> {
  const targetIndex = new BookIndex(target);
  let processed = 0;

  const stats: DiffStats = {
    sourceTotal: sources.length,
    skippedNoAudio: 0,
    present: 0,
    missing: 0,
    uncertain: 0,
    missingBytes: 0,
  };

  interface Pending {
    book: BookRecord;
    /** Carried between passes; deriving it is the expensive part of matching. */
    identity: BookIdentity;
    status: 'missing' | 'uncertain';
    nearestTargetMatch: ScoredMatch | null;
  }
  const pending: Pending[] = [];

  for (const book of sources) {
    if (yieldEvery > 0 && ++processed % yieldEvery === 0) yield;
    if (options.requireAudio && !book.hasAudio) {
      stats.skippedNoAudio++;
      continue;
    }
    const identity = deriveIdentity(book);
    const match = targetIndex.findBest(identity, options);
    if (match && isConfident(match)) {
      stats.present++;
      continue;
    }
    pending.push({
      book,
      identity,
      status: match ? 'uncertain' : 'missing',
      nearestTargetMatch: match,
    });
  }

  // Second pass: cluster the pending items against each other so the same work
  // from multiple servers collapses into one row.
  const clusterIndex = new BookIndex();
  const clusters = new Map<string, MissingBook>();

  for (const entry of pending) {
    if (yieldEvery > 0 && ++processed % yieldEvery === 0) yield;
    const identity = entry.identity;
    const existing = clusterIndex.findBest(identity, options);

    if (existing && isConfident(existing)) {
      const cluster = clusters.get(existing.candidate.key);
      if (cluster) {
        cluster.copies.push(entry.book);
        // An `uncertain` verdict anywhere in the cluster wins, so a possible
        // duplicate is never silently presented as a clean miss.
        if (entry.status === 'uncertain' && cluster.status === 'missing') {
          cluster.status = 'uncertain';
          cluster.nearestTargetMatch = entry.nearestTargetMatch;
        }
        continue;
      }
    }

    clusterIndex.addIdentity(identity);
    clusters.set(entry.book.key, {
      id: entry.book.key,
      representative: entry.book,
      copies: [entry.book],
      status: entry.status,
      nearestTargetMatch: entry.nearestTargetMatch,
    });
  }

  const missing = [...clusters.values()];
  for (const cluster of missing) {
    cluster.representative = pickBestCopy(cluster.copies);
    if (cluster.status === 'missing') stats.missing++;
    else stats.uncertain++;
    stats.missingBytes += cluster.representative.sizeBytes ?? 0;
  }

  missing.sort(compareForDisplay);
  return { missing, stats };
}

/** Series/sequence-aware ordering, falling back to author then title. */
function compareForDisplay(a: MissingBook, b: MissingBook): number {
  const seriesA = a.representative.series?.[0];
  const seriesB = b.representative.series?.[0];
  const nameA = normalizeSeries(seriesA?.name ?? '');
  const nameB = normalizeSeries(seriesB?.name ?? '');
  if (nameA && nameB && nameA !== nameB) return nameA.localeCompare(nameB);
  if (nameA && !nameB) return -1;
  if (!nameA && nameB) return 1;
  if (nameA && nameA === nameB) {
    const seqA = Number.parseFloat(seriesA?.sequence ?? '') || 0;
    const seqB = Number.parseFloat(seriesB?.sequence ?? '') || 0;
    if (seqA !== seqB) return seqA - seqB;
  }
  const authorA = normalizePerson(a.representative.authors?.[0] ?? '');
  const authorB = normalizePerson(b.representative.authors?.[0] ?? '');
  if (authorA !== authorB) return authorA.localeCompare(authorB);
  return a.representative.title.localeCompare(b.representative.title);
}

export interface GroupedMissing<T> {
  key: string;
  label: string;
  items: T[];
  totalBytes: number;
}

function group<T>(
  items: readonly T[],
  keyOf: (item: T) => { key: string; label: string },
  bytesOf: (item: T) => number,
): GroupedMissing<T>[] {
  interface Bucket {
    key: string;
    items: T[];
    totalBytes: number;
    /** Every spelling seen for this group, with how often it appeared. */
    labels: Map<string, number>;
  }
  const map = new Map<string, Bucket>();

  for (const item of items) {
    const { key, label } = keyOf(item);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { key, items: [], totalBytes: 0, labels: new Map() };
      map.set(key, bucket);
    }
    bucket.items.push(item);
    bucket.totalBytes += bytesOf(item);
    bucket.labels.set(label, (bucket.labels.get(label) ?? 0) + 1);
  }

  return [...map.values()]
    .map((bucket) => ({
      key: bucket.key,
      // Servers spell series and author names inconsistently ("Stormlight
      // Archive" vs "The Stormlight Archive"). Pick the most common spelling,
      // breaking ties toward the longest so the fuller form wins.
      label: pickLabel(bucket.labels),
      items: bucket.items,
      totalBytes: bucket.totalBytes,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function pickLabel(labels: Map<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [label, count] of labels) {
    if (count > bestCount || (count === bestCount && label.length > best.length)) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

export function groupBySeries(missing: readonly MissingBook[]): GroupedMissing<MissingBook>[] {
  return group(
    missing,
    (item) => {
      const series = item.representative.series?.[0];
      const key = normalizeSeries(series?.name ?? '');
      return key
        ? { key: `series:${key}`, label: series!.name }
        : { key: 'standalone', label: 'Standalone' };
    },
    (item) => item.representative.sizeBytes ?? 0,
  );
}

export function groupByAuthor(missing: readonly MissingBook[]): GroupedMissing<MissingBook>[] {
  return group(
    missing,
    (item) => {
      const author = item.representative.authors?.[0];
      const key = normalizePerson(author ?? '');
      return key ? { key: `author:${key}`, label: author! } : { key: 'unknown', label: 'Unknown author' };
    },
    (item) => item.representative.sizeBytes ?? 0,
  );
}
