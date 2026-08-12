import type { BookRecord } from '@abs-sync/core';
import { AbsClient } from '@abs-sync/abs-client';
import { describeError, logActivity } from './activity';
import { invalidateCompareCache } from './compare';
import { prisma } from './db';
import { getEnv } from './env';
import { recordToRow } from './records';
import { clientFor } from './servers';

export type IndexMode = 'auto' | 'full' | 'incremental';
export type IndexRunMode = 'full' | 'incremental';

export interface IndexSummary {
  serverId: string;
  serverName: string;
  runId: string;
  status: 'completed' | 'failed' | 'canceled';
  mode: IndexRunMode;
  itemsIndexed: number;
  itemsRemoved: number;
  librariesIndexed: number;
  /** Set when an incremental attempt had to fall back to a full crawl. */
  escalatedBecause?: string;
  /** API page requests made, so the saving from incremental is visible. */
  pageRequests: number;
  error?: string;
  durationMs: number;
}

/** Rows written per transaction. Large enough to be fast, small enough to stream. */
const WRITE_CHUNK = 200;

/**
 * Pages walked before an incremental attempt gives up. Past this, a full crawl
 * is cheaper than continuing to guess.
 */
const INCREMENTAL_MAX_PAGES = 20;

async function flush(rows: ReturnType<typeof recordToRow>[]): Promise<void> {
  if (rows.length === 0) return;
  // upsert keyed on (serverId, absItemId): re-indexing must update in place so
  // that job history and watch references stay valid.
  await prisma.$transaction(
    rows.map((row) =>
      prisma.indexedItem.upsert({
        where: { serverId_absItemId: { serverId: row.serverId, absItemId: row.absItemId } },
        create: row,
        update: row,
      }),
    ),
  );
}

interface LibraryRow {
  id: string;
  absId: string;
  name: string;
  included: boolean;
}

/**
 * Newest source-side timestamp we hold for a library, in the column matching the
 * sort key. Each key needs its own baseline: Audiobookshelf populates all three
 * fields but only orders by some of them, so a baseline taken from the wrong
 * column would be meaningless.
 */
async function baselineFor(libraryId: string, sortField: string): Promise<number | null> {
  if (sortField === 'mtimeMs') {
    const row = await prisma.indexedItem.findFirst({
      where: { libraryId, absMtimeMs: { not: null } },
      orderBy: { absMtimeMs: 'desc' },
      select: { absMtimeMs: true },
    });
    return row?.absMtimeMs ?? null;
  }
  if (sortField === 'addedAt') {
    const row = await prisma.indexedItem.findFirst({
      where: { libraryId, absAddedAt: { not: null } },
      orderBy: { absAddedAt: 'desc' },
      select: { absAddedAt: true },
    });
    return row?.absAddedAt ?? null;
  }
  const row = await prisma.indexedItem.findFirst({
    where: { libraryId, absUpdatedAt: { not: null } },
    orderBy: { absUpdatedAt: 'desc' },
    select: { absUpdatedAt: true },
  });
  return row?.absUpdatedAt ? row.absUpdatedAt.getTime() : null;
}

/** Compares a record's timestamp for the given key, for change detection. */
function stampFor(record: BookRecord, sortField: string): number | null {
  const raw =
    sortField === 'mtimeMs' ? record.mtimeMs : sortField === 'addedAt' ? record.addedAt : record.updatedAt;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** Max ids per `IN (...)` lookup, well under SQLite's parameter ceiling. */
const ID_LOOKUP_CHUNK = 400;

/**
 * Narrows fetched records to those we do not already hold at the same
 * modification time. Items whose timestamp matches what is stored have not
 * changed, so re-upserting them would be pure churn.
 */
async function filterChanged(
  serverId: string,
  records: BookRecord[],
  sortField: string,
): Promise<BookRecord[]> {
  if (records.length === 0) return [];

  const known = new Map<string, number | null>();
  for (let offset = 0; offset < records.length; offset += ID_LOOKUP_CHUNK) {
    const ids = records.slice(offset, offset + ID_LOOKUP_CHUNK).map((record) => record.itemId);
    const rows = await prisma.indexedItem.findMany({
      where: { serverId, absItemId: { in: ids } },
      select: { absItemId: true, absUpdatedAt: true, absMtimeMs: true, absAddedAt: true },
    });
    for (const row of rows) {
      const stored =
        sortField === 'mtimeMs'
          ? row.absMtimeMs
          : sortField === 'addedAt'
            ? row.absAddedAt
            : (row.absUpdatedAt?.getTime() ?? null);
      known.set(row.absItemId, stored ?? null);
    }
  }

  return records.filter((record) => {
    if (!known.has(record.itemId)) return true; // never seen
    const stored = known.get(record.itemId) ?? null;
    const incoming = stampFor(record, sortField);
    // Missing timestamps on either side: re-write rather than risk staleness.
    if (stored === null || incoming === null) return true;
    return incoming !== stored;
  });
}

class EscalateToFull extends Error {
  constructor(readonly why: string) {
    super(why);
    this.name = 'EscalateToFull';
  }
}

/**
 * Rebuilds the cached index for one server.
 *
 * Two modes:
 *
 * - **full** — crawls every library, upserts everything with a run timestamp,
 *   then deletes rows the run did not touch. This is what reconciles deletions,
 *   since Audiobookshelf offers no "what changed" feed.
 * - **incremental** — asks for items newest-first and stops at the first one
 *   older than what we already hold. One new book costs one request instead of
 *   one per hundred books. It cannot see deletions, so it never prunes.
 *
 * `auto` picks incremental when there is a usable baseline and a full reconcile
 * has happened recently enough, and escalates to full whenever the incremental
 * path cannot be trusted — no baseline, a server that ignores the sort key, or
 * more changes than the page budget allows.
 */
export async function indexServer(
  serverId: string,
  options: {
    signal?: AbortSignal;
    enrich?: boolean;
    mode?: IndexMode;
    onProgress?: (indexed: number) => void;
  } = {},
): Promise<IndexSummary> {
  const startedAt = Date.now();
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { libraries: true },
  });
  if (!server) throw new Error(`Server ${serverId} not found`);

  const requested: IndexMode = options.mode ?? 'auto';
  const { fullReindexHours } = getEnv();
  const libraries = server.libraries.filter((library) => library.included);

  // Decide the mode before opening a run, so the row records what really ran.
  let mode: IndexRunMode;
  let escalatedBecause: string | undefined;
  if (requested === 'full') {
    mode = 'full';
  } else if (!server.lastFullIndexAt) {
    mode = 'full';
    if (requested === 'incremental') escalatedBecause = 'this server has never had a full index';
  } else if (
    requested === 'auto' &&
    Date.now() - server.lastFullIndexAt.getTime() > fullReindexHours * 3_600_000
  ) {
    mode = 'full';
  } else {
    mode = 'incremental';
  }

  const run = await prisma.indexRun.create({ data: { serverId, status: 'running', mode } });

  let itemsIndexed = 0;
  let itemsRemoved = 0;
  let librariesIndexed = 0;
  let pageRequests = 0;

  const finishRun = async (status: 'completed' | 'failed' | 'canceled', error?: string) => {
    await prisma.indexRun.update({
      where: { id: run.id },
      data: {
        status,
        mode,
        itemsIndexed,
        itemsRemoved,
        finishedAt: new Date(),
        ...(error ? { error } : {}),
      },
    });
    // Any indexed row that moved makes a cached comparison stale.
    if (itemsIndexed > 0 || itemsRemoved > 0) invalidateCompareCache();
  };

  try {
    const client = clientFor(server);

    if (libraries.length === 0) {
      await logActivity('index', `"${server.name}" has no libraries selected for syncing`, {
        level: 'warn',
        data: { serverId },
      });
    }

    if (mode === 'incremental') {
      try {
        const result = await runIncremental(
          serverId,
          client,
          server.itemSortField,
          libraries,
          options,
        );
        itemsIndexed = result.itemsIndexed;
        librariesIndexed = result.librariesIndexed;
        pageRequests = result.pageRequests;
        if (result.sortField && result.sortField !== server.itemSortField) {
          await prisma.server.update({
            where: { id: serverId },
            data: { itemSortField: result.sortField },
          });
        }
      } catch (error) {
        if (!(error instanceof EscalateToFull)) throw error;
        escalatedBecause = error.why;
        mode = 'full';
        itemsIndexed = 0;
        librariesIndexed = 0;
        pageRequests = 0;
        // A sort key that stopped working must not be reused.
        if (server.itemSortField) {
          await prisma.server.update({ where: { id: serverId }, data: { itemSortField: null } });
        }
      }
    }

    if (mode === 'full') {
      const result = await runFull(client, libraries, options);
      itemsIndexed = result.itemsIndexed;
      itemsRemoved = result.itemsRemoved;
      librariesIndexed = result.librariesIndexed;
      pageRequests = result.pageRequests;
    }

    await finishRun('completed');
    await prisma.server.update({
      where: { id: serverId },
      data: {
        lastIndexedAt: new Date(),
        lastError: null,
        ...(mode === 'full' ? { lastFullIndexAt: new Date() } : {}),
      },
    });

    const changed = mode === 'incremental';
    await logActivity(
      'index',
      changed
        ? `Incrementally indexed "${server.name}": ${itemsIndexed} new or changed book(s) in ` +
            `${pageRequests} request(s)` +
            (escalatedBecause ? ` (after falling back: ${escalatedBecause})` : '')
        : `Fully indexed "${server.name}": ${itemsIndexed} book(s) across ${librariesIndexed} ` +
            `librar${librariesIndexed === 1 ? 'y' : 'ies'}` +
            (itemsRemoved > 0 ? `, ${itemsRemoved} removed` : '') +
            (escalatedBecause ? ` (full crawl because ${escalatedBecause})` : ''),
      { data: { serverId, runId: run.id, mode, pageRequests } },
    );

    return {
      serverId,
      serverName: server.name,
      runId: run.id,
      status: 'completed',
      mode,
      itemsIndexed,
      itemsRemoved,
      librariesIndexed,
      pageRequests,
      ...(escalatedBecause ? { escalatedBecause } : {}),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const canceled = error instanceof Error && error.name === 'AbortError';
    const message = describeError(error);

    await finishRun(canceled ? 'canceled' : 'failed', message);
    if (!canceled) {
      await prisma.server.update({ where: { id: serverId }, data: { lastError: message } });
      await logActivity('index', `Indexing "${server.name}" failed: ${message}`, {
        level: 'error',
        data: { serverId, runId: run.id, mode },
      });
    }

    return {
      serverId,
      serverName: server.name,
      runId: run.id,
      status: canceled ? 'canceled' : 'failed',
      mode,
      itemsIndexed,
      itemsRemoved,
      librariesIndexed,
      pageRequests,
      ...(escalatedBecause ? { escalatedBecause } : {}),
      error: message,
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Crawls every library and prunes anything the run did not see. */
async function runFull(
  client: AbsClient,
  libraries: LibraryRow[],
  options: { signal?: AbortSignal; enrich?: boolean; onProgress?: (indexed: number) => void },
): Promise<{ itemsIndexed: number; itemsRemoved: number; librariesIndexed: number; pageRequests: number }> {
  const runStart = new Date();
  let itemsIndexed = 0;
  let itemsRemoved = 0;
  let librariesIndexed = 0;
  let pageRequests = 0;

  for (const library of libraries) {
    if (options.signal?.aborted) throw new DOMException('Indexing canceled', 'AbortError');

    let libraryCount = 0;
    let buffer: ReturnType<typeof recordToRow>[] = [];

    for await (const record of client.iterateBooks(library.absId, {
      signal: options.signal,
      enrich: options.enrich ?? false,
      onProgress: () => {
        pageRequests++;
      },
    })) {
      buffer.push(recordToRow(record as BookRecord, library.id, runStart));
      libraryCount++;
      itemsIndexed++;
      if (buffer.length >= WRITE_CHUNK) {
        await flush(buffer);
        buffer = [];
        options.onProgress?.(itemsIndexed);
      }
    }
    await flush(buffer);
    options.onProgress?.(itemsIndexed);

    // Prune items this run did not see — this is what catches upstream deletions.
    const pruned = await prisma.indexedItem.deleteMany({
      where: { libraryId: library.id, seenAt: { lt: runStart } },
    });
    itemsRemoved += pruned.count;
    librariesIndexed++;

    await prisma.library.update({
      where: { id: library.id },
      data: { itemCount: libraryCount, lastIndexedAt: new Date() },
    });
  }

  return { itemsIndexed, itemsRemoved, librariesIndexed, pageRequests };
}

/**
 * Fetches only what changed since the newest timestamp we hold, per library.
 * Throws EscalateToFull whenever the result cannot be trusted to be complete.
 */
async function runIncremental(
  serverId: string,
  client: AbsClient,
  knownSortField: string | null,
  libraries: LibraryRow[],
  options: { signal?: AbortSignal; enrich?: boolean; onProgress?: (indexed: number) => void },
): Promise<{ itemsIndexed: number; librariesIndexed: number; pageRequests: number; sortField: string | null }> {
  const now = new Date();
  let itemsIndexed = 0;
  let librariesIndexed = 0;
  let pageRequests = 0;
  // A key proven on one library is tried first on the next.
  let sortField: string | null = knownSortField;

  for (const library of libraries) {
    if (options.signal?.aborted) throw new DOMException('Indexing canceled', 'AbortError');

    // Try the known-good key first, then the rest. Each attempt needs a baseline
    // from its own column, which is why the loop lives here and not in the
    // client: only the database knows what we already hold.
    const candidates = sortField
      ? [sortField, ...AbsClient.MODIFIED_SORT_CANDIDATES.filter((key) => key !== sortField)]
      : [...AbsClient.MODIFIED_SORT_CANDIDATES];

    let accepted: Awaited<ReturnType<AbsClient['fetchBooksModifiedSince']>> | null = null;
    /** Non-null narrowing of `sortField` once a candidate is accepted. */
    let acceptedField: string | null = null;
    const rejected: string[] = [];

    for (const candidate of candidates) {
      const baseline = await baselineFor(library.id, candidate);
      if (baseline === null) {
        rejected.push(`${candidate} (no stored baseline)`);
        continue;
      }

      const result = await client.fetchBooksModifiedSince(library.absId, {
        since: baseline,
        sortField: candidate,
        pageSize: 100,
        maxPages: INCREMENTAL_MAX_PAGES,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      pageRequests += result.pagesFetched;

      if (!result.ordered) {
        rejected.push(`${candidate} (not honoured by the server)`);
        continue;
      }
      if (!result.reachedOlder && !result.exhausted) {
        throw new EscalateToFull(
          `more than ${INCREMENTAL_MAX_PAGES} pages of "${library.name}" changed since the last index`,
        );
      }
      accepted = result;
      sortField = candidate;
      acceptedField = candidate;
      break;
    }

    if (!accepted || !acceptedField) {
      throw new EscalateToFull(
        `no usable newest-first sort key for "${library.name}" — tried ${rejected.join(', ')}`,
      );
    }

    // The `since` comparison is inclusive so an item changed in the same
    // millisecond as our baseline is never missed. The cost is that items on the
    // boundary come back every run, so filter to what genuinely changed before
    // writing. This also makes the reported count mean "new or changed".
    const changed = await filterChanged(serverId, accepted.records, acceptedField);

    if (changed.length > 0) {
      const rows = changed.map((record) => recordToRow(record, library.id, now));
      for (let offset = 0; offset < rows.length; offset += WRITE_CHUNK) {
        const chunk = rows.slice(offset, offset + WRITE_CHUNK);
        await flush(chunk);
        itemsIndexed += chunk.length;
        options.onProgress?.(itemsIndexed);
      }
    }

    // Recount authoritatively rather than inferring: incremental never prunes,
    // so the library total comes from what we actually hold.
    const total = await prisma.indexedItem.count({ where: { libraryId: library.id } });
    await prisma.library.update({
      where: { id: library.id },
      data: { itemCount: total, lastIndexedAt: new Date() },
    });
    librariesIndexed++;
  }

  return { itemsIndexed, librariesIndexed, pageRequests, sortField };
}

/** Indexes every enabled server, one at a time to stay polite to remote hosts. */
export async function indexAllServers(
  options: { signal?: AbortSignal; enrich?: boolean; mode?: IndexMode } = {},
): Promise<IndexSummary[]> {
  const servers = await prisma.server.findMany({
    where: { enabled: true },
    select: { id: true },
    orderBy: { name: 'asc' },
  });

  const summaries: IndexSummary[] = [];
  for (const server of servers) {
    if (options.signal?.aborted) break;
    summaries.push(await indexServer(server.id, options));
  }
  return summaries;
}

/** True when a server has never been indexed or its index is older than maxAge. */
export async function isIndexStale(serverId: string, maxAgeMs: number): Promise<boolean> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { lastIndexedAt: true },
  });
  if (!server?.lastIndexedAt) return true;
  return Date.now() - server.lastIndexedAt.getTime() > maxAgeMs;
}
