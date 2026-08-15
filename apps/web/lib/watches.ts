import {
  DEFAULT_DIFF_OPTIONS,
  diffAgainstTarget,
  normalizeSeries,
  type BookRecord,
} from '@abs-sync/core';
import { describeError, logActivity } from './activity';
import { prisma } from './db';
import { rowToRecord } from './records';
import { enqueueSync } from './sync-worker';

export interface CreateWatchInput {
  seriesName: string;
  author?: string | null;
  /** Our Library.id on the target. Defaults to the target's first included library. */
  targetLibraryId?: string;
  targetFolderId?: string;
  /** "all", or an explicit list of source server ids. */
  sourceServerIds?: string[];
  autoEnqueue?: boolean;
}

export class WatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchError';
  }
}

export interface PublicWatch {
  id: string;
  seriesName: string;
  author: string | null;
  enabled: boolean;
  autoEnqueue: boolean;
  sourceScope: string;
  sourceServerNames: string[];
  targetLibraryName: string;
  lastCheckedAt: Date | null;
  lastFoundAt: Date | null;
  createdAt: Date;
  /** Books synced so far because of this watch. */
  syncedCount: number;
}

export async function createWatch(input: CreateWatchInput): Promise<PublicWatch> {
  const seriesName = input.seriesName.trim();
  if (!seriesName) throw new WatchError('Series name is required');
  const normSeries = normalizeSeries(seriesName);
  if (!normSeries) throw new WatchError(`"${seriesName}" does not look like a series name`);

  const target = await prisma.server.findFirst({
    where: { isTarget: true },
    include: { libraries: { where: { included: true }, orderBy: { name: 'asc' } } },
  });
  if (!target) throw new WatchError('Configure a target server before watching a series');

  const library = input.targetLibraryId
    ? target.libraries.find((candidate) => candidate.id === input.targetLibraryId)
    : target.libraries[0];
  if (!library) throw new WatchError(`No included library on "${target.name}" to sync into`);

  let folders: Array<{ id: string; fullPath: string }> = [];
  try {
    folders = JSON.parse(library.foldersJson);
  } catch {
    folders = [];
  }
  const folderId = input.targetFolderId ?? folders[0]?.id;
  if (!folderId) throw new WatchError(`Library "${library.name}" has no folder to upload into`);

  const existing = await prisma.seriesWatch.findUnique({
    where: { normSeries_targetLibraryId: { normSeries, targetLibraryId: library.id } },
  });
  if (existing) throw new WatchError(`"${seriesName}" is already being watched for this library`);

  const watch = await prisma.seriesWatch.create({
    data: {
      seriesName,
      normSeries,
      author: input.author?.trim() || null,
      targetServerId: target.id,
      targetLibraryId: library.id,
      targetFolderId: folderId,
      sourceScope:
        input.sourceServerIds && input.sourceServerIds.length > 0
          ? JSON.stringify(input.sourceServerIds)
          : 'all',
      autoEnqueue: input.autoEnqueue ?? true,
    },
  });

  await logActivity('watch', `Now watching series "${seriesName}"`, {
    data: { watchId: watch.id, autoEnqueue: watch.autoEnqueue },
  });

  const result = await getWatch(watch.id);
  return result!;
}

function parseScope(scope: string): string[] | 'all' {
  if (scope === 'all') return 'all';
  try {
    const parsed = JSON.parse(scope);
    return Array.isArray(parsed) ? (parsed as string[]) : 'all';
  } catch {
    return 'all';
  }
}

async function toPublicWatch(watch: {
  id: string;
  seriesName: string;
  author: string | null;
  enabled: boolean;
  autoEnqueue: boolean;
  sourceScope: string;
  targetLibraryId: string;
  lastCheckedAt: Date | null;
  lastFoundAt: Date | null;
  createdAt: Date;
}): Promise<PublicWatch> {
  const scope = parseScope(watch.sourceScope);
  const [library, servers, syncedCount] = await Promise.all([
    prisma.library.findUnique({ where: { id: watch.targetLibraryId }, select: { name: true } }),
    scope === 'all'
      ? prisma.server.findMany({ where: { enabled: true, isTarget: false }, select: { name: true } })
      : prisma.server.findMany({ where: { id: { in: scope } }, select: { name: true } }),
    prisma.syncJob.count({ where: { watchId: watch.id, status: 'completed' } }),
  ]);

  return {
    id: watch.id,
    seriesName: watch.seriesName,
    author: watch.author,
    enabled: watch.enabled,
    autoEnqueue: watch.autoEnqueue,
    sourceScope: watch.sourceScope,
    sourceServerNames: servers.map((server) => server.name),
    targetLibraryName: library?.name ?? 'Library',
    lastCheckedAt: watch.lastCheckedAt,
    lastFoundAt: watch.lastFoundAt,
    createdAt: watch.createdAt,
    syncedCount,
  };
}

export async function getWatch(id: string): Promise<PublicWatch | null> {
  const watch = await prisma.seriesWatch.findUnique({ where: { id } });
  return watch ? toPublicWatch(watch) : null;
}

export async function listWatches(): Promise<PublicWatch[]> {
  const watches = await prisma.seriesWatch.findMany({ orderBy: { seriesName: 'asc' } });
  return Promise.all(watches.map(toPublicWatch));
}

export async function setWatchEnabled(id: string, enabled: boolean): Promise<void> {
  await prisma.seriesWatch.update({ where: { id }, data: { enabled } });
}

export async function deleteWatch(id: string): Promise<void> {
  const watch = await prisma.seriesWatch.findUnique({ where: { id } });
  if (!watch) return;
  await prisma.seriesWatch.delete({ where: { id } });
  await logActivity('watch', `Stopped watching "${watch.seriesName}"`, { data: { watchId: id } });
}

export interface WatchEvaluation {
  watchId: string;
  seriesName: string;
  /** Candidate books found in the series across the watched sources. */
  candidates: number;
  /** Books the target is missing. */
  missing: number;
  enqueued: number;
  /** Findings recorded as suggestions because autoEnqueue is off. */
  suggested: number;
  /** Already queued/completed, or rejected by the queue. */
  skipped: number;
  error?: string;
}

/**
 * Evaluates one watch: finds books in the watched series that live on a source
 * server but not on the target, and queues them.
 *
 * Only `missing` findings are auto-queued — `uncertain` ones (where the target
 * has something similar) are logged instead, because unattended automation
 * should never risk creating duplicates in someone's library.
 */
export async function evaluateWatch(
  watchId: string,
  preloaded?: { targetRecords: BookRecord[] },
): Promise<WatchEvaluation> {
  const watch = await prisma.seriesWatch.findUnique({ where: { id: watchId } });
  if (!watch) throw new WatchError('Watch not found');

  const base: WatchEvaluation = {
    watchId,
    seriesName: watch.seriesName,
    candidates: 0,
    missing: 0,
    enqueued: 0,
    suggested: 0,
    skipped: 0,
  };

  try {
    // Cheap guard first: an unindexed target looks like it owns nothing, and the
    // watch would try to pull the entire series. Check before doing any work.
    const targetIndexed = await prisma.indexedItem.count({
      where: { serverId: watch.targetServerId },
    });
    if (targetIndexed === 0) {
      const message = 'target server has no index yet; skipping to avoid mass-queueing';
      await prisma.seriesWatch.update({ where: { id: watchId }, data: { lastCheckedAt: new Date() } });
      await logActivity('watch', `Watch "${watch.seriesName}" skipped: ${message}`, { level: 'warn' });
      return { ...base, error: message };
    }

    const scope = parseScope(watch.sourceScope);
    const sources = await prisma.server.findMany({
      where:
        scope === 'all'
          ? { enabled: true, isTarget: false }
          : { id: { in: scope }, enabled: true, isTarget: false },
      select: { id: true, name: true, canDownload: true },
    });
    if (sources.length === 0) {
      await prisma.seriesWatch.update({ where: { id: watchId }, data: { lastCheckedAt: new Date() } });
      return base;
    }

    // Candidate rows: same normalized series on any watched source.
    const candidateRows = await prisma.indexedItem.findMany({
      where: {
        serverId: { in: sources.map((server) => server.id) },
        normSeries: watch.normSeries,
        library: { included: true },
      },
    });

    const candidates = candidateRows
      .map(rowToRecord)
      .filter((record) => {
        if (!watch.author) return true;
        // Optional author constraint, for series names that collide.
        const wanted = watch.author.toLowerCase();
        return record.authors.some((author) => author.toLowerCase().includes(wanted));
      });
    base.candidates = candidates.length;

    if (candidates.length === 0) {
      await prisma.seriesWatch.update({ where: { id: watchId }, data: { lastCheckedAt: new Date() } });
      return base;
    }

    const targetRecords =
      preloaded?.targetRecords ??
      (await prisma.indexedItem.findMany({ where: { serverId: watch.targetServerId } })).map(rowToRecord);

    // `preloaded` comes from evaluateAllWatches, which may have loaded before an
    // index was cleared, so re-check rather than trusting the earlier count.
    if (targetRecords.length === 0) {
      const message = 'target server has no index yet; skipping to avoid mass-queueing';
      await prisma.seriesWatch.update({ where: { id: watchId }, data: { lastCheckedAt: new Date() } });
      return { ...base, error: message };
    }

    const diff = diffAgainstTarget(candidates, targetRecords, {
      ...DEFAULT_DIFF_OPTIONS,
      requireAudio: true,
    });
    base.missing = diff.stats.missing;

    for (const book of diff.missing) {
      if (book.status !== 'missing') {
        base.suggested++;
        continue;
      }

      if (!watch.autoEnqueue) {
        base.suggested++;
        await logActivity(
          'watch',
          `"${book.representative.title}" is available for watched series "${watch.seriesName}"`,
          { data: { watchId, itemId: book.representative.itemId, serverId: book.representative.serverId } },
        );
        continue;
      }

      // A watch runs unattended and on a schedule, so it is the one path where
      // a wrong guess repeats. When the available copies are different
      // recordings there is no defensible automatic answer — picking the first
      // downloadable one would pull whichever edition happened to sort first,
      // which is how you end up with an abridgement you never asked for. Report
      // it and let a human choose on the compare page instead.
      if (book.editionsDiffer) {
        base.suggested++;
        await logActivity(
          'watch',
          `"${book.representative.title}" is available for watched series "${watch.seriesName}" ` +
            `but the copies are not the same recording (${book.editionsDiffer}) — choose one to sync`,
          {
            data: {
              watchId,
              itemId: book.representative.itemId,
              serverId: book.representative.serverId,
              editionsDiffer: book.editionsDiffer,
            },
          },
        );
        continue;
      }

      // Prefer a copy we are actually allowed to download.
      const downloadable = book.copies.find(
        (copy) => sources.find((server) => server.id === copy.serverId)?.canDownload,
      );
      const chosen = downloadable ?? book.representative;

      const outcome = await enqueueSync({
        sourceServerId: chosen.serverId,
        sourceItemId: chosen.itemId,
        sourceLibraryId: chosen.libraryId,
        targetLibraryId: watch.targetLibraryId,
        targetFolderId: watch.targetFolderId,
        title: chosen.title,
        author: chosen.authors?.[0] ?? null,
        series: chosen.series?.[0]?.name ?? watch.seriesName,
        origin: 'watch',
        watchId,
      });

      if (outcome.status === 'queued') {
        base.enqueued++;
        await logActivity(
          'watch',
          `Auto-queued "${chosen.title}" from watched series "${watch.seriesName}"`,
          { data: { watchId, jobId: outcome.jobId } },
        );
      } else {
        base.skipped++;
        if (outcome.status === 'rejected') {
          await logActivity(
            'watch',
            `Could not queue "${chosen.title}" for "${watch.seriesName}": ${outcome.reason}`,
            { level: 'warn', data: { watchId } },
          );
        }
      }
    }

    await prisma.seriesWatch.update({
      where: { id: watchId },
      data: {
        lastCheckedAt: new Date(),
        ...(base.enqueued > 0 || base.suggested > 0 ? { lastFoundAt: new Date() } : {}),
      },
    });

    return base;
  } catch (error) {
    const message = describeError(error);
    await logActivity('watch', `Watch "${watch.seriesName}" failed: ${message}`, { level: 'error' });
    return { ...base, error: message };
  }
}

/** Evaluates every enabled watch, loading the target index only once. */
export async function evaluateAllWatches(): Promise<WatchEvaluation[]> {
  const watches = await prisma.seriesWatch.findMany({ where: { enabled: true } });
  if (watches.length === 0) return [];

  const target = await prisma.server.findFirst({ where: { isTarget: true }, select: { id: true } });
  const targetRecords = target
    ? (await prisma.indexedItem.findMany({ where: { serverId: target.id } })).map(rowToRecord)
    : [];

  const results: WatchEvaluation[] = [];
  for (const watch of watches) {
    results.push(await evaluateWatch(watch.id, { targetRecords }));
  }
  return results;
}

/**
 * Series present on sources that the target has no book from at all — the most
 * useful suggestions for what to start watching.
 */
export async function suggestSeriesToWatch(limit = 25): Promise<
  Array<{ seriesName: string; normSeries: string; availableCount: number; serverNames: string[] }>
> {
  const target = await prisma.server.findFirst({ where: { isTarget: true }, select: { id: true } });
  if (!target) return [];

  const watched = await prisma.seriesWatch.findMany({ select: { normSeries: true } });
  const watchedSet = new Set(watched.map((watch) => watch.normSeries));

  const targetSeries = await prisma.indexedItem.findMany({
    where: { serverId: target.id, normSeries: { not: null } },
    select: { normSeries: true },
    distinct: ['normSeries'],
  });
  const owned = new Set(targetSeries.map((row) => row.normSeries!));

  const sourceRows = await prisma.indexedItem.findMany({
    where: {
      serverId: { not: target.id },
      normSeries: { not: null },
      library: { included: true },
      server: { enabled: true },
    },
    select: { normSeries: true, seriesJson: true, serverId: true },
  });

  const grouped = new Map<string, { seriesName: string; count: number; servers: Set<string> }>();
  for (const row of sourceRows) {
    const norm = row.normSeries!;
    if (owned.has(norm) || watchedSet.has(norm)) continue;
    let displayName = norm;
    try {
      const parsed = JSON.parse(row.seriesJson) as Array<{ name?: string }>;
      displayName = parsed[0]?.name ?? norm;
    } catch {
      // Keep the normalized form as the label.
    }
    const entry = grouped.get(norm) ?? { seriesName: displayName, count: 0, servers: new Set<string>() };
    entry.count++;
    entry.servers.add(row.serverId);
    grouped.set(norm, entry);
  }

  const serverNames = new Map(
    (await prisma.server.findMany({ select: { id: true, name: true } })).map((server) => [
      server.id,
      server.name,
    ]),
  );

  return [...grouped.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([norm, entry]) => ({
      seriesName: entry.seriesName,
      normSeries: norm,
      availableCount: entry.count,
      serverNames: [...entry.servers].map((id) => serverNames.get(id) ?? 'Unknown'),
    }));
}
