import {
  DEFAULT_DIFF_OPTIONS,
  diffAgainstTargetAsync,
  groupByAuthor,
  groupBySeries,
  type BookRecord,
  type DiffOptions,
  type DiffResult,
  type MissingBook,
  type SeriesRef,
} from '@abs-sync/core';
import { prisma } from './db';
import { rowToRecord } from './records';

export interface CompareRequest {
  /** Defaults to the configured target server. */
  targetServerId?: string;
  /** Defaults to every enabled server other than the target. */
  sourceServerIds?: string[];
  requireAudio?: boolean;
  /** Include books the target may already own under a different title. */
  includeUncertain?: boolean;
  /** Free-text filter over title, author and series. */
  search?: string;
  groupBy?: 'series' | 'author' | 'none';
}

export interface MissingCopyView {
  serverId: string;
  serverName: string;
  itemId: string;
  libraryId: string;
  libraryName: string;
  sizeBytes: number | null;
  durationSec: number | null;
  numAudioFiles: number | null;
  canDownload: boolean;
}

export interface MissingBookView {
  id: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  narrators: string[];
  series: SeriesRef[];
  asin: string | null;
  isbn: string | null;
  publishedYear: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  hasEbook: boolean;
  status: 'missing' | 'uncertain';
  /** Populated when status is `uncertain`: the closest thing already owned. */
  nearest: {
    title: string;
    authors: string[];
    score: number;
    tier: string;
    reasons: string[];
  } | null;
  copies: MissingCopyView[];
  /** Preferred copy for cover art and for a one-click sync. */
  bestCopy: MissingCopyView;
  /** Existing job for this book, if any. */
  job: { id: string; status: string; phase: string } | null;
}

export interface CompareGroupView {
  key: string;
  label: string;
  totalBytes: number;
  items: MissingBookView[];
}

export interface CompareResult {
  target: { id: string; name: string; itemCount: number } | null;
  sources: Array<{ id: string; name: string; itemCount: number; canDownload: boolean }>;
  stats: {
    sourceTotal: number;
    present: number;
    missing: number;
    uncertain: number;
    missingBytes: number;
    skippedNoAudio: number;
    /** Books shown after search/status filtering. */
    shown: number;
  };
  groups: CompareGroupView[];
  /** Set when the comparison could not be run. */
  problem: string | null;
  /** When the underlying diff was computed, and whether this call reused it. */
  diff: { computedAt: Date; fromCache: boolean; computeMs: number } | null;
}

/** The cheap half of a comparison: which servers are involved. */
export interface CompareSources {
  target: { id: string; name: string } | null;
  sources: Array<{ id: string; name: string; canDownload: boolean }>;
}

/**
 * Resolves just the target and source servers.
 *
 * Split out so the filter controls can render before the diff has run — the
 * diff takes seconds on a large library, and blocking the whole page on it
 * makes a navigation look broken.
 */
export async function compareSources(sourceServerIds?: string[]): Promise<CompareSources> {
  const target = await prisma.server.findFirst({ where: { isTarget: true } });
  if (!target) return { target: null, sources: [] };

  const sources = await prisma.server.findMany({
    where: {
      enabled: true,
      id: sourceServerIds?.length ? { in: sourceServerIds, not: target.id } : { not: target.id },
    },
    select: { id: true, name: true, canDownload: true },
    orderBy: { name: 'asc' },
  });

  return { target: { id: target.id, name: target.name }, sources };
}

interface LoadedRecords {
  records: BookRecord[];
  serverNames: Map<string, string>;
  libraryNames: Map<string, string>;
  downloadable: Map<string, boolean>;
}

async function loadRecords(serverIds: string[]): Promise<LoadedRecords> {
  if (serverIds.length === 0) {
    return { records: [], serverNames: new Map(), libraryNames: new Map(), downloadable: new Map() };
  }

  const rows = await prisma.indexedItem.findMany({
    where: { serverId: { in: serverIds }, library: { included: true } },
  });
  const servers = await prisma.server.findMany({
    where: { id: { in: serverIds } },
    select: { id: true, name: true, canDownload: true },
  });
  const libraries = await prisma.library.findMany({
    where: { serverId: { in: serverIds } },
    select: { id: true, name: true },
  });

  return {
    records: rows.map(rowToRecord),
    serverNames: new Map(servers.map((server) => [server.id, server.name])),
    libraryNames: new Map(libraries.map((library) => [library.id, library.name])),
    downloadable: new Map(servers.map((server) => [server.id, server.canDownload])),
  };
}

// --------------------------------------------------------------- diff caching

/**
 * Cached diff results, keyed by the servers involved and a fingerprint of the
 * index they were computed from.
 *
 * The diff is pure — it reads only the local index — but it is not cheap: on a
 * 1,338-book source library it costs ~3s, dominated by edit-distance scoring
 * during clustering. Without caching, every filter change, every search
 * keystroke and every background refresh pays that cost again, which is what
 * made navigating to the page feel like it had hung.
 *
 * Only a handful of entries are kept; the key changes whenever the index does,
 * so stale entries are worthless rather than wrong.
 */
interface DiffCacheEntry {
  result: DiffResult;
  targetCount: number;
  sourceCountsByServer: Map<string, number>;
  computedAt: Date;
  computeMs: number;
}

const MAX_CACHE_ENTRIES = 4;

const globalForCache = globalThis as unknown as {
  absSyncDiffCache?: Map<string, DiffCacheEntry>;
};
/** Held on globalThis so dev-mode hot reloads do not discard it. */
const diffCache: Map<string, DiffCacheEntry> = (globalForCache.absSyncDiffCache ??= new Map());

/**
 * Fingerprints the indexed rows the diff will read. Row count plus the newest
 * `seenAt` changes on any add, removal or re-index, which is exactly when a
 * cached diff stops being valid.
 */
async function indexFingerprint(serverIds: string[]): Promise<string> {
  const summary = await prisma.indexedItem.aggregate({
    where: { serverId: { in: serverIds }, library: { included: true } },
    _count: { _all: true },
    _max: { seenAt: true },
  });
  return `${summary._count._all}@${summary._max.seenAt?.getTime() ?? 0}`;
}

/** Drops the comparison cache. Call after anything that rewrites the index. */
export function invalidateCompareCache(): void {
  diffCache.clear();
}

function matchesSearch(book: MissingBook, needle: string): boolean {
  const haystack = [
    book.representative.title,
    book.representative.subtitle ?? '',
    ...(book.representative.authors ?? []),
    ...(book.representative.narrators ?? []),
    ...(book.representative.series ?? []).map((series) => series.name),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Runs a full comparison from the cached index.
 *
 * Everything comes out of SQLite — no network calls — so this is safe to call on
 * every page render. Re-index when you want fresher data.
 */
export async function compare(request: CompareRequest = {}): Promise<CompareResult> {
  const empty: CompareResult = {
    target: null,
    sources: [],
    stats: {
      sourceTotal: 0,
      present: 0,
      missing: 0,
      uncertain: 0,
      missingBytes: 0,
      skippedNoAudio: 0,
      shown: 0,
    },
    groups: [],
    problem: null,
    diff: null,
  };

  const target = request.targetServerId
    ? await prisma.server.findUnique({ where: { id: request.targetServerId } })
    : await prisma.server.findFirst({ where: { isTarget: true } });

  if (!target) {
    return {
      ...empty,
      problem: 'No target server is configured yet. Add your own server and mark it as the sync target.',
    };
  }

  const candidateSources = await prisma.server.findMany({
    where: {
      enabled: true,
      id: request.sourceServerIds?.length
        ? { in: request.sourceServerIds, not: target.id }
        : { not: target.id },
    },
    select: { id: true, name: true, canDownload: true },
    orderBy: { name: 'asc' },
  });

  if (candidateSources.length === 0) {
    return {
      ...empty,
      target: { id: target.id, name: target.name, itemCount: 0 },
      problem: 'No other servers to compare against. Add a friend’s server to get started.',
    };
  }

  const targetData = await loadRecords([target.id]);
  const sourceData = await loadRecords(candidateSources.map((server) => server.id));

  if (targetData.records.length === 0) {
    return {
      ...empty,
      target: { id: target.id, name: target.name, itemCount: 0 },
      sources: candidateSources.map((server) => ({
        id: server.id,
        name: server.name,
        itemCount: 0,
        canDownload: server.canDownload,
      })),
      problem:
        `"${target.name}" has not been indexed yet. Run an index first — comparing against an ` +
        'empty index would report your entire collection as missing.',
    };
  }

  const options: DiffOptions = {
    ...DEFAULT_DIFF_OPTIONS,
    requireAudio: request.requireAudio ?? DEFAULT_DIFF_OPTIONS.requireAudio,
  };

  const sourceIds = candidateSources.map((server) => server.id);
  const cacheKey = [
    target.id,
    [...sourceIds].sort().join(','),
    `audio=${options.requireAudio}`,
    await indexFingerprint([target.id, ...sourceIds]),
  ].join('|');

  let entry = diffCache.get(cacheKey);
  const fromCache = entry !== undefined;
  if (!entry) {
    const startedAt = Date.now();
    // Yields periodically: this is seconds of synchronous scoring, and blocking
    // the event loop would stall the streaming response and every other request.
    const computed = await diffAgainstTargetAsync(sourceData.records, targetData.records, options);
    entry = {
      result: computed,
      targetCount: targetData.records.length,
      sourceCountsByServer: new Map(
        sourceIds.map((id) => [id, sourceData.records.filter((record) => record.serverId === id).length]),
      ),
      computedAt: new Date(),
      computeMs: Date.now() - startedAt,
    };
    diffCache.set(cacheKey, entry);
    // Evict oldest-inserted first; Map preserves insertion order.
    while (diffCache.size > MAX_CACHE_ENTRIES) {
      const oldest = diffCache.keys().next();
      if (oldest.done) break;
      diffCache.delete(oldest.value);
    }
  }
  const result = entry.result;

  // Which of these are already queued or done?
  const jobs = await prisma.syncJob.findMany({
    where: {
      targetServerId: target.id,
      status: { in: ['queued', 'running', 'completed', 'failed'] },
    },
    select: {
      id: true,
      status: true,
      phase: true,
      sourceServerId: true,
      sourceItemId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  const jobByCopy = new Map<string, { id: string; status: string; phase: string }>();
  for (const job of jobs) {
    const key = `${job.sourceServerId}:${job.sourceItemId}`;
    // findMany is newest-first, so the first write per key wins.
    if (!jobByCopy.has(key)) {
      jobByCopy.set(key, { id: job.id, status: job.status, phase: job.phase });
    }
  }

  const includeUncertain = request.includeUncertain ?? false;
  const needle = request.search?.trim().toLowerCase() ?? '';

  const filtered = result.missing.filter((book) => {
    if (!includeUncertain && book.status === 'uncertain') return false;
    if (needle && !matchesSearch(book, needle)) return false;
    return true;
  });

  const toCopyView = (record: BookRecord): MissingCopyView => ({
    serverId: record.serverId,
    serverName: sourceData.serverNames.get(record.serverId) ?? 'Unknown server',
    itemId: record.itemId,
    libraryId: record.libraryId,
    libraryName: sourceData.libraryNames.get(record.libraryId) ?? 'Library',
    sizeBytes: record.sizeBytes ?? null,
    durationSec: record.durationSec ?? null,
    numAudioFiles: record.numAudioFiles ?? null,
    canDownload: sourceData.downloadable.get(record.serverId) ?? false,
  });

  const toView = (book: MissingBook): MissingBookView => {
    const representative = book.representative;
    const copies = book.copies.map(toCopyView);
    const bestCopy = toCopyView(representative);
    // Prefer a copy we can actually download when the largest one is off-limits.
    const preferred = copies.find((copy) => copy.itemId === bestCopy.itemId && copy.canDownload)
      ?? copies.find((copy) => copy.canDownload)
      ?? bestCopy;

    return {
      id: book.id,
      title: representative.title,
      subtitle: representative.subtitle ?? null,
      authors: representative.authors ?? [],
      narrators: representative.narrators ?? [],
      series: representative.series ?? [],
      asin: representative.asin ?? null,
      isbn: representative.isbn ?? null,
      publishedYear: representative.publishedYear ?? null,
      durationSec: representative.durationSec ?? null,
      sizeBytes: representative.sizeBytes ?? null,
      hasEbook: representative.hasEbook,
      status: book.status,
      nearest: book.nearestTargetMatch
        ? {
            title: book.nearestTargetMatch.candidate.title,
            authors: book.nearestTargetMatch.candidate.authors ?? [],
            score: book.nearestTargetMatch.score,
            tier: book.nearestTargetMatch.tier,
            reasons: book.nearestTargetMatch.reasons,
          }
        : null,
      copies,
      bestCopy: preferred,
      job: jobByCopy.get(`${preferred.serverId}:${preferred.itemId}`) ?? null,
    };
  };

  let groups: CompareGroupView[];
  const groupBy = request.groupBy ?? 'series';
  if (groupBy === 'none') {
    groups = [
      {
        key: 'all',
        label: 'All missing books',
        totalBytes: filtered.reduce((sum, book) => sum + (book.representative.sizeBytes ?? 0), 0),
        items: filtered.map(toView),
      },
    ];
  } else {
    const grouped = groupBy === 'author' ? groupByAuthor(filtered) : groupBySeries(filtered);
    groups = grouped.map((group) => ({
      key: group.key,
      label: group.label,
      totalBytes: group.totalBytes,
      items: group.items.map(toView),
    }));
  }

  return {
    target: { id: target.id, name: target.name, itemCount: entry.targetCount },
    sources: candidateSources.map((server) => ({
      id: server.id,
      name: server.name,
      itemCount: entry.sourceCountsByServer.get(server.id) ?? 0,
      canDownload: server.canDownload,
    })),
    stats: { ...result.stats, shown: filtered.length },
    groups,
    problem: null,
    diff: { computedAt: entry.computedAt, fromCache, computeMs: entry.computeMs },
  };
}
