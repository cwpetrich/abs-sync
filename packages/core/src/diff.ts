import {
  BookIndex,
  DEFAULT_MATCH_OPTIONS,
  deriveIdentity,
  describeEditionConflict,
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
/** Why `pickBestCopy` preferred the representative over its siblings. */
export type CopyChoiceReason = 'only' | 'longest' | 'largest' | 'most-files' | 'tie';

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
  /**
   * Set when the clustered copies are the same work but not the same recording
   * — different narrators, or runtimes too far apart to be one reading.
   *
   * Copies of a single recording are interchangeable and picking one for the
   * user is a convenience. Copies of different recordings are not, and choosing
   * silently would hand someone an abridgement they never asked for, so callers
   * are expected to make the choice explicit instead of taking the default.
   */
  editionsDiffer: string | null;
  /** Why `representative` won, so an automatic choice stays reviewable. */
  chosenBy: CopyChoiceReason;
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

/**
 * Which tiebreak actually decided `chosen`, mirroring `pickBestCopy`'s order.
 * Surfacing this is what turns "we picked one" into "we picked the longest".
 */
export function explainCopyChoice(
  copies: readonly BookRecord[],
  chosen: BookRecord,
): CopyChoiceReason {
  const others = copies.filter((copy) => copy !== chosen);
  if (others.length === 0) return 'only';

  const runnerUp = pickBestCopy(others);
  if (Math.abs((chosen.durationSec ?? 0) - (runnerUp.durationSec ?? 0)) > 60) return 'longest';
  if ((chosen.sizeBytes ?? 0) !== (runnerUp.sizeBytes ?? 0)) return 'largest';
  if ((chosen.numAudioFiles ?? 0) !== (runnerUp.numAudioFiles ?? 0)) return 'most-files';
  return 'tie';
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
  // Identities are kept per cluster so edition divergence can be judged across
  // every pair once clustering settles, rather than depending on the order
  // copies happened to arrive in. Reusing them costs nothing; re-deriving would
  // repeat the most expensive part of matching.
  const clusterIdentities = new Map<string, BookIdentity[]>();

  for (const entry of pending) {
    if (yieldEvery > 0 && ++processed % yieldEvery === 0) yield;
    const identity = entry.identity;
    const existing = clusterIndex.findBest(identity, options);

    if (existing && isConfident(existing)) {
      const cluster = clusters.get(existing.candidate.key);
      if (cluster) {
        cluster.copies.push(entry.book);
        clusterIdentities.get(cluster.id)?.push(identity);
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
    clusterIdentities.set(entry.book.key, [identity]);
    clusters.set(entry.book.key, {
      id: entry.book.key,
      representative: entry.book,
      copies: [entry.book],
      status: entry.status,
      nearestTargetMatch: entry.nearestTargetMatch,
      editionsDiffer: null,
      chosenBy: 'only',
    });
  }

  const missing = [...clusters.values()];
  for (const cluster of missing) {
    cluster.representative = pickBestCopy(cluster.copies);
    cluster.chosenBy = explainCopyChoice(cluster.copies, cluster.representative);
    cluster.editionsDiffer = describeClusterDivergence(clusterIdentities.get(cluster.id) ?? [], options);
    if (cluster.status === 'missing') stats.missing++;
    else stats.uncertain++;
    stats.missingBytes += cluster.representative.sizeBytes ?? 0;
  }

  missing.sort(compareForDisplay);
  return { missing, stats };
}

/**
 * The first thing separating any two copies in a cluster, or null when they are
 * all the same recording. Pairwise is fine: a cluster holds one work's copies,
 * so the list is a handful of entries at most.
 */
function describeClusterDivergence(
  identities: readonly BookIdentity[],
  options: DiffOptions,
): string | null {
  for (let i = 0; i < identities.length; i++) {
    for (let j = i + 1; j < identities.length; j++) {
      const conflict = describeEditionConflict(identities[i]!, identities[j]!, options);
      if (conflict) return conflict;
    }
  }
  return null;
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

// ------------------------------------------------------------- group ordering

/**
 * How the grouped view is ordered.
 *
 * `name` is alphabetical by label. The other two answer the two different
 * versions of "what is new": `released` finds series whose latest instalment
 * came out recently, `added` finds what a friend's server picked up recently —
 * which for a decades-old backlist is a completely different answer.
 */
export type GroupSort = 'name' | 'released' | 'added';

export interface ReleaseDate {
  /** Epoch millis. Start of the year when that is all the source knows. */
  at: number;
  /**
   * False when the figure was reconstructed from a bare year. Carried so a
   * display never prints "1 January" for a book whose server only said "2011".
   */
  exact: boolean;
}

/**
 * A record's release date, or null when the source gave none.
 *
 * `publishedDate` is preferred and `publishedYear` stands in as January 1st of
 * that year, so a library indexed before dates were stored still orders by
 * decade and year — just not within one.
 */
export function releaseOf(record: BookRecord): ReleaseDate | null {
  const date = record.publishedDate?.trim();
  // A bare year is what plenty of servers put in the date field. Parsing fine,
  // it would otherwise be reported as precise and displayed as a month.
  if (date && !/^\d{1,4}$/.test(date)) {
    const parsed = Date.parse(date);
    if (!Number.isNaN(parsed)) return { at: parsed, exact: true };
  }
  // `||` rather than `??`: an empty string is as absent as a missing field.
  const year = Number.parseInt(record.publishedYear?.trim() || date || '', 10);
  if (!Number.isFinite(year)) return null;
  // Set the year explicitly rather than via Date.UTC, whose two-digit-year
  // remapping would turn a year 11 book into a 1911 one.
  const start = new Date(0);
  start.setUTCFullYear(year, 0, 1);
  const at = start.getTime();
  return Number.isNaN(at) ? null : { at, exact: false };
}

function newestOf<T>(items: readonly T[], timeOf: (item: T) => number | null): number | null {
  let newest: number | null = null;
  for (const item of items) {
    const time = timeOf(item);
    if (time !== null && (newest === null || time > newest)) newest = time;
  }
  return newest;
}

/**
 * Newest release date across a set of books, or null when none of them carry
 * one. Copies of one work are meant to agree, so taking the newest across them
 * just means the copy with the richest metadata decides.
 */
export function newestRelease(books: readonly MissingBook[]): ReleaseDate | null {
  let newest: ReleaseDate | null = null;
  for (const book of books) {
    for (const copy of book.copies) {
      const release = releaseOf(copy);
      if (release && (!newest || release.at > newest.at)) newest = release;
    }
  }
  return newest;
}

/**
 * When any source server most recently gained one of these books, epoch millis.
 * Null when no copy reports an added time.
 */
export function newestAddition(books: readonly MissingBook[]): number | null {
  return newestOf(books, (book) => newestOf(book.copies, (copy) => copy.addedAt ?? null));
}

/**
 * Reorders groups without touching the books inside them — a series stays in
 * reading order however the groups themselves are sorted.
 *
 * Groups whose books carry no usable date sort last rather than as epoch zero,
 * which would otherwise park every unlabelled book at the top of a "newest
 * first" list.
 */
export function sortGroups(
  groups: readonly GroupedMissing<MissingBook>[],
  sort: GroupSort,
): GroupedMissing<MissingBook>[] {
  if (sort === 'name') return [...groups].sort((a, b) => a.label.localeCompare(b.label));
  const timeOf =
    sort === 'released'
      ? (items: readonly MissingBook[]) => newestRelease(items)?.at ?? null
      : newestAddition;
  return [...groups]
    .map((group) => ({ group, time: timeOf(group.items) }))
    .sort((a, b) => {
      if (a.time === null || b.time === null) {
        if (a.time !== b.time) return a.time === null ? 1 : -1;
      } else if (a.time !== b.time) {
        return b.time - a.time;
      }
      return a.group.label.localeCompare(b.group.label);
    })
    .map((entry) => entry.group);
}
