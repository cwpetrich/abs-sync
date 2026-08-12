import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { AbsPayloadTooLargeError, type AbsItemFile } from '@abs-sync/abs-client';
import { formatBytes, normalizePerson, normalizeTitle } from '@abs-sync/core';
import type { SyncJob } from '../generated/prisma/client';
import { describeError, logActivity } from './activity';
import { prisma } from './db';
import { getEnv } from './env';
import { clientFor } from './servers';

export interface EnqueueInput {
  sourceServerId: string;
  sourceItemId: string;
  sourceLibraryId: string;
  /** Our Library.id on the target. Defaults to the target's first included library. */
  targetLibraryId?: string;
  targetFolderId?: string;
  title: string;
  author?: string | null;
  series?: string | null;
  origin?: 'manual' | 'watch';
  watchId?: string | null;
}

export type EnqueueOutcome =
  | { status: 'queued'; jobId: string }
  | { status: 'duplicate'; jobId: string; existingStatus: string }
  | { status: 'rejected'; reason: string };

/** File kinds worth transferring. Metadata sidecars are left behind. */
const TRANSFERABLE: ReadonlySet<AbsItemFile['kind']> = new Set(['audio', 'ebook', 'image']);

/** Minimum interval between progress writes, to avoid hammering SQLite. */
const PROGRESS_INTERVAL_MS = 1_500;

export async function enqueueSync(input: EnqueueInput): Promise<EnqueueOutcome> {
  const target = await prisma.server.findFirst({
    where: { isTarget: true },
    include: { libraries: { where: { included: true }, orderBy: { name: 'asc' } } },
  });
  if (!target) return { status: 'rejected', reason: 'No target server is configured' };
  if (!target.canUpload) {
    return {
      status: 'rejected',
      reason: `"${target.name}" cannot receive uploads — its account lacks the upload permission`,
    };
  }

  const source = await prisma.server.findUnique({ where: { id: input.sourceServerId } });
  if (!source) return { status: 'rejected', reason: 'Source server not found' };
  if (!source.enabled) return { status: 'rejected', reason: `"${source.name}" is disabled` };
  if (!source.canDownload) {
    return {
      status: 'rejected',
      reason: `"${source.name}" cannot be downloaded from — its account lacks the download permission`,
    };
  }

  const library = input.targetLibraryId
    ? target.libraries.find((candidate) => candidate.id === input.targetLibraryId)
    : target.libraries[0];
  if (!library) {
    return {
      status: 'rejected',
      reason: `No included library on "${target.name}" to receive this book`,
    };
  }

  let folders: Array<{ id: string; fullPath: string }> = [];
  try {
    folders = JSON.parse(library.foldersJson);
  } catch {
    folders = [];
  }
  const folderId = input.targetFolderId ?? folders[0]?.id;
  if (!folderId) {
    return {
      status: 'rejected',
      reason: `Library "${library.name}" on "${target.name}" has no folder to upload into`,
    };
  }

  const LIVE_STATUSES = ['queued', 'running', 'completed'];

  const existing = await prisma.syncJob.findFirst({
    where: {
      sourceServerId: input.sourceServerId,
      sourceItemId: input.sourceItemId,
      targetServerId: target.id,
      status: { in: LIVE_STATUSES },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    return { status: 'duplicate', jobId: existing.id, existingStatus: existing.status };
  }

  // Identity-level dedupe. Without this, syncing a book from one friend and then
  // letting a watch run before the target is re-indexed would queue the same
  // book again from a different server — a duplicate audiobook in the library.
  const normTitle = normalizeTitle(input.title).norm;
  const normAuthor = normalizePerson(input.author ?? '');
  if (normTitle) {
    const sameWork = await prisma.syncJob.findFirst({
      where: {
        targetServerId: target.id,
        normTitle,
        normAuthor,
        status: { in: LIVE_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (sameWork) {
      return { status: 'duplicate', jobId: sameWork.id, existingStatus: sameWork.status };
    }
  }

  const shared = {
    sourceLibraryId: input.sourceLibraryId,
    targetLibraryId: library.id,
    targetFolderId: folderId,
    title: input.title,
    author: input.author ?? null,
    series: input.series ?? null,
    normTitle,
    normAuthor,
    origin: input.origin ?? 'manual',
    watchId: input.watchId ?? null,
  };

  // Revive the previous attempt at this exact book rather than adding a row.
  // Asking for the same transfer again is a retry, not a second transfer, and a
  // list with four rows for one book makes "which one do I retry?" unanswerable.
  // The retained download comes along with it, so nothing is re-fetched.
  const stopped = await prisma.syncJob.findMany({
    where: {
      sourceServerId: input.sourceServerId,
      sourceItemId: input.sourceItemId,
      targetServerId: target.id,
      status: { in: ['failed', 'canceled'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  // Prefer an attempt that still has its audio on disk over a newer empty one.
  const previous = stopped.find((job) => job.spoolPath !== null) ?? stopped[0];
  if (previous) {
    await prisma.syncJob.update({
      where: { id: previous.id },
      data: {
        ...shared,
        status: 'queued',
        phase: 'pending',
        attempts: 0,
        error: null,
        downloadedBytes: 0,
        uploadedBytes: 0,
        startedAt: null,
        finishedAt: null,
      },
    });
    getWorker().wake();
    return { status: 'queued', jobId: previous.id };
  }

  const job = await prisma.syncJob.create({
    data: {
      ...shared,
      sourceServerId: input.sourceServerId,
      sourceItemId: input.sourceItemId,
      targetServerId: target.id,
    },
  });

  getWorker().wake();
  return { status: 'queued', jobId: job.id };
}

/** How often retained spools are re-checked against the disk budget. */
const SWEEP_INTERVAL_MS = 5 * 60_000;

export class SyncWorker {
  private readonly active = new Map<string, AbortController>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private recovered = false;
  private lastSweep = 0;

  get activeCount(): number {
    return this.active.size;
  }

  /** Whether a transfer is running right now, so its spool is off-limits. */
  isActive(jobId: string): boolean {
    return this.active.has(jobId);
  }

  /** Starts periodic polling. Safe to call repeatedly. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 5_000);
    // Node would keep the process alive for this timer alone; it should not.
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Nudges the worker to pick up newly queued work immediately. */
  wake(): void {
    void this.tick();
  }

  cancel(jobId: string): boolean {
    const controller = this.active.get(jobId);
    if (!controller) return false;
    controller.abort(new DOMException('Canceled by user', 'AbortError'));
    return true;
  }

  /**
   * Requeues jobs left mid-flight by a crash or restart.
   *
   * Their spool directories are kept: whatever finished downloading is still
   * valid, and the requeued attempt verifies every file against the size the
   * source reports, so the one file that was mid-write when the process died is
   * re-fetched while the rest are not. Deleting the spool here used to throw away
   * gigabytes on every restart.
   */
  private async recover(): Promise<void> {
    if (this.recovered) return;
    this.recovered = true;

    const stranded = await prisma.syncJob.findMany({ where: { status: 'running' } });
    for (const job of stranded) {
      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'queued',
          phase: 'pending',
          downloadedBytes: 0,
          uploadedBytes: 0,
        },
      });
    }
    if (stranded.length > 0) {
      await logActivity(
        'sync',
        `Requeued ${stranded.length} transfer${stranded.length === 1 ? '' : 's'} interrupted by a restart`,
        { level: 'warn' },
      );
    }

    this.lastSweep = Date.now();
    await this.sweepOrphanedSpools();
  }

  /**
   * Deletes spool directories with no corresponding live job.
   *
   * A crash between "mark completed" and the cleanup in `finally` would
   * otherwise leave a full copy of an audiobook on disk forever.
   */
  private async sweepOrphanedSpools(): Promise<void> {
    const root = getEnv().spoolDir;
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      // Nothing spooled yet; the directory is created on first transfer.
      return;
    }
    if (entries.length === 0) return;

    // `failed` counts as retainable: those are the transfers most likely to be
    // retried by hand once whatever blocked them is fixed, and re-downloading a
    // whole audiobook to hand the receiving server the same bytes is pure waste.
    const live = await prisma.syncJob.findMany({
      where: { id: { in: entries }, status: { in: ['queued', 'running', 'failed'] } },
      select: { id: true, status: true, createdAt: true, finishedAt: true },
    });
    const retainable = new Map(live.map((job) => [job.id, job]));

    let removed = 0;
    for (const entry of entries) {
      if (retainable.has(entry) || this.active.has(entry)) continue;
      await rm(path.join(root, entry), { recursive: true, force: true }).catch(() => undefined);
      removed++;
    }
    if (removed > 0) {
      console.log(`[abs-sync] removed ${removed} orphaned spool director(ies)`);
    }

    await this.enforceSpoolBudget([...retainable.values()]);
  }

  /**
   * Keeps retained spools within `ABS_SYNC_SPOOL_KEEP_BYTES`.
   *
   * Retaining downloads for retryable transfers is only safe if it is bounded —
   * two dozen stalled books would otherwise sit on disk indefinitely and could
   * fill the volume. Least-recently-updated jobs are evicted first, and jobs
   * currently transferring are never touched.
   */
  private async enforceSpoolBudget(
    retained: Array<{ id: string; status: string; createdAt: Date; finishedAt: Date | null }>,
  ): Promise<void> {
    const budget = getEnv().spoolKeepBytes;
    const root = getEnv().spoolDir;

    // Only unfinished-but-idle work is evictable; queued/running jobs need theirs.
    const idleSince = (job: { createdAt: Date; finishedAt: Date | null }) =>
      (job.finishedAt ?? job.createdAt).getTime();
    const evictable = retained
      .filter((job) => job.status === 'failed' && !this.active.has(job.id))
      .sort((a, b) => idleSince(a) - idleSince(b));

    const sizes = new Map<string, number>();
    let total = 0;
    for (const job of retained) {
      const size = await directorySize(path.join(root, job.id));
      sizes.set(job.id, size);
      total += size;
    }
    if (budget > 0 && total <= budget) return;

    let freed = 0;
    let evicted = 0;
    for (const job of evictable) {
      if (budget > 0 && total - freed <= budget) break;
      await rm(path.join(root, job.id), { recursive: true, force: true }).catch(() => undefined);
      await prisma.syncJob
        .update({ where: { id: job.id }, data: { spoolPath: null } })
        .catch(() => undefined);
      freed += sizes.get(job.id) ?? 0;
      evicted++;
    }

    if (evicted > 0) {
      await logActivity(
        'sync',
        `Freed ${formatBytes(freed)} of retained downloads from ${evicted} failed transfer(s) to stay ` +
          `under the ${formatBytes(budget)} spool budget (ABS_SYNC_SPOOL_KEEP_BYTES). Those will ` +
          're-download if retried.',
        { level: 'warn' },
      );
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.recover();

      // Retained downloads accumulate while the process runs, so the budget has
      // to be re-checked as we go. Enforcing it only at startup would let a long
      // session grow without limit.
      if (Date.now() - this.lastSweep > SWEEP_INTERVAL_MS) {
        this.lastSweep = Date.now();
        await this.sweepOrphanedSpools();
      }

      const { maxConcurrentSyncs } = getEnv();

      while (this.active.size < maxConcurrentSyncs) {
        const next = await prisma.syncJob.findFirst({
          where: { status: 'queued' },
          orderBy: { createdAt: 'asc' },
        });
        if (!next) break;

        // Claim the job before awaiting anything else, so two ticks cannot
        // both pick it up.
        const claimed = await prisma.syncJob.updateMany({
          where: { id: next.id, status: 'queued' },
          data: { status: 'running', phase: 'pending', startedAt: new Date() },
        });
        if (claimed.count === 0) continue;

        const controller = new AbortController();
        this.active.set(next.id, controller);
        void this.runJob(next, controller.signal)
          .catch((error: unknown) => {
            console.error('[abs-sync] transfer crashed:', describeError(error));
          })
          .finally(() => {
            this.active.delete(next.id);
            // Pull the next item as soon as a slot frees up.
            void this.tick();
          });
      }
    } catch (error) {
      console.error('[abs-sync] worker tick failed:', describeError(error));
    } finally {
      this.ticking = false;
    }
  }

  private spoolDir(jobId: string): string {
    return path.join(getEnv().spoolDir, jobId);
  }

  private async cleanupSpool(jobId: string): Promise<void> {
    try {
      await rm(this.spoolDir(jobId), { recursive: true, force: true });
    } catch (error) {
      console.error(`[abs-sync] could not clean spool for ${jobId}:`, describeError(error));
    }
  }

  private async runJob(job: SyncJob, signal: AbortSignal): Promise<void> {
    const env = getEnv();
    const spool = this.spoolDir(job.id);
    let downloaded: Array<{ filename: string; localPath: string; size: number }> = [];
    /**
     * Whether the downloaded audio should survive this attempt. Kept when the
     * transfer might yet be retried, so the retry does not pull the whole
     * audiobook down again; dropped once it can never be useful.
     */
    let keepSpool = false;

    try {
      const [source, target, targetLibrary] = await Promise.all([
        prisma.server.findUnique({ where: { id: job.sourceServerId } }),
        prisma.server.findUnique({ where: { id: job.targetServerId } }),
        prisma.library.findUnique({ where: { id: job.targetLibraryId } }),
      ]);
      if (!source) throw new Error('Source server no longer exists');
      if (!target) throw new Error('Target server no longer exists');
      if (!targetLibrary) throw new Error('Target library no longer exists');

      const sourceClient = clientFor(source);
      const targetClient = clientFor(target);

      // --- enumerate -------------------------------------------------------
      const listing = await sourceClient.listItemFilesDetailed(job.sourceItemId, signal);
      const files = listing.files.filter((file) => TRANSFERABLE.has(file.kind));
      const audioCount = files.filter((file) => file.kind === 'audio').length;

      if (listing.unfetchableAudio.length > 0) {
        // These have no downloadable ino, so continuing would upload an
        // audiobook with chapters silently missing.
        throw new Error(
          `"${source.name}" lists ${listing.unfetchableAudio.length} audio file(s) that are not in the ` +
            `item's file listing and cannot be downloaded (first: "${listing.unfetchableAudio[0]}"). ` +
            'A re-scan of the item on the source server usually fixes this.',
        );
      }

      if (listing.staleDuplicates > 0) {
        await logActivity(
          'sync',
          `"${source.name}" reported ${listing.staleDuplicates} duplicate audio file entr${
            listing.staleDuplicates === 1 ? 'y' : 'ies'
          } for "${job.title}" — transferring the ${files.length} real file(s). The item's duration and ` +
            'size on that server are inflated by the same amount.',
          { level: 'warn', data: { jobId: job.id } },
        );
      }

      if (audioCount === 0) {
        // Whole-item download would hand us a zip, which ABS cannot ingest as
        // audio — it would create a broken item. Refuse instead.
        throw new Error(
          `"${source.name}" did not report any audio files for this item, so it cannot be ` +
            'transferred safely. (The whole-item download endpoint returns a zip archive, which ' +
            'Audiobookshelf cannot import as audio.)',
        );
      }

      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > env.maxItemSizeBytes) {
        throw new Error(
          `Item is ${formatBytes(totalBytes)}, which exceeds the ${formatBytes(env.maxItemSizeBytes)} ` +
            'per-item limit (ABS_SYNC_MAX_ITEM_BYTES)',
        );
      }

      await prisma.syncJob.update({
        where: { id: job.id },
        data: { phase: 'downloading', totalBytes: totalBytes || null, spoolPath: spool },
      });

      // --- download --------------------------------------------------------
      await mkdir(spool, { recursive: true });
      /** Bytes from files already fully written. */
      let completedBytes = 0;
      let lastWrite = 0;
      let reusedFiles = 0;
      let reusedBytes = 0;

      await discardStaleSpoolFiles(spool, files);

      for (const file of files) {
        signal.throwIfAborted();
        const localPath = spoolPathFor(spool, file);

        // A previous attempt may already have fetched this file. Reuse it only
        // when the size matches the source exactly — anything else is a partial
        // write from an interrupted attempt and must be fetched again.
        const reusable = await completeOnDisk(localPath, file.size);
        if (reusable !== null) {
          reusedFiles++;
          reusedBytes += reusable;
          completedBytes += reusable;
          downloaded.push({ filename: sanitize(file.filename), localPath, size: reusable });
          continue;
        }

        const handle = await sourceClient.openFileDownload(job.sourceItemId, file.ino, { signal });

        // Count inside the pipeline rather than via a 'data' listener: attaching
        // 'data' puts the stream in flowing mode before the writable is wired
        // up, which can drop the first chunks.
        let fileBytes = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            fileBytes += chunk.length;
            const now = Date.now();
            if (now - lastWrite > PROGRESS_INTERVAL_MS) {
              lastWrite = now;
              void prisma.syncJob
                .update({ where: { id: job.id }, data: { downloadedBytes: completedBytes + fileBytes } })
                .catch(() => undefined);
            }
            callback(null, chunk);
          },
        });

        const readable = Readable.fromWeb(handle.stream as unknown as NodeWebReadableStream<Uint8Array>);
        await pipeline(readable, counter, createWriteStream(localPath), { signal });

        const written = await stat(localPath);
        // A truncated download must fail loudly rather than upload a broken file.
        if (file.size > 0 && written.size !== file.size) {
          throw new Error(
            `Downloaded "${file.filename}" is ${formatBytes(written.size)} but the source reported ` +
              `${formatBytes(file.size)} — the transfer was truncated`,
          );
        }
        completedBytes += written.size;
        downloaded.push({ filename: sanitize(file.filename), localPath, size: written.size });
      }

      if (reusedFiles > 0) {
        await logActivity(
          'sync',
          `Reused ${reusedFiles} of ${files.length} already-downloaded file(s) for "${job.title}" ` +
            `(${formatBytes(reusedBytes)} not fetched again)`,
          { data: { jobId: job.id } },
        );
      }

      const downloadedTotal = completedBytes;
      await prisma.syncJob.update({
        where: { id: job.id },
        data: { phase: 'uploading', downloadedBytes: downloadedTotal, totalBytes: downloadedTotal },
      });

      // --- upload ----------------------------------------------------------
      let lastUploadWrite = 0;
      const uploadResult = await targetClient.upload({
        libraryId: targetLibrary.absId,
        folderId: job.targetFolderId,
        title: job.title,
        ...(job.author ? { author: job.author } : {}),
        ...(job.series ? { series: job.series } : {}),
        files: downloaded.map((file) => ({
          filename: file.filename,
          size: file.size,
          open: () =>
            Readable.toWeb(createReadStream(file.localPath)) as unknown as ReadableStream<Uint8Array>,
        })),
        onProgress: (bytesSent) => {
          const now = Date.now();
          if (now - lastUploadWrite > PROGRESS_INTERVAL_MS) {
            lastUploadWrite = now;
            void prisma.syncJob
              .update({ where: { id: job.id }, data: { uploadedBytes: bytesSent } })
              .catch(() => undefined);
          }
        },
        signal,
      });

      const resultItemId =
        uploadResult.libraryItem?.id ??
        uploadResult.libraryItems?.[0]?.id ??
        uploadResult.results?.[0]?.id ??
        null;

      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          phase: 'finalizing',
          uploadedBytes: downloadedTotal,
          finishedAt: new Date(),
          resultItemId,
          error: null,
          spoolPath: null,
        },
      });

      await logActivity(
        'sync',
        `Synced "${job.title}" from "${source.name}" to "${target.name}" (${formatBytes(downloadedTotal)}, ` +
          `${downloaded.length} file${downloaded.length === 1 ? '' : 's'})`,
        { data: { jobId: job.id, resultItemId, origin: job.origin } },
      );
    } catch (error) {
      const canceled =
        signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const message = describeError(error);
      const attempts = job.attempts + 1;
      // Some failures cannot be fixed by sending the same bytes again. Retrying a
      // rejected-as-too-large upload means re-downloading the entire audiobook to
      // fail identically, twice more.
      const permanent = error instanceof AbsPayloadTooLargeError;
      const willRetry = !canceled && !permanent && attempts < job.maxAttempts;

      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: canceled ? 'canceled' : willRetry ? 'queued' : 'failed',
          phase: 'pending',
          attempts,
          error: message,
          // The downloaded bytes are still on disk unless this was canceled, and
          // the next attempt will recount them as it verifies each file.
          downloadedBytes: 0,
          uploadedBytes: 0,
          spoolPath: canceled ? null : spool,
          ...(canceled || !willRetry ? { finishedAt: new Date() } : {}),
        },
      });

      // A cancelled transfer is done with; anything else may be retried, either
      // automatically or by hand once the cause is fixed.
      keepSpool = !canceled;

      await logActivity(
        'sync',
        canceled
          ? `Canceled "${job.title}"`
          : willRetry
            ? `Transfer of "${job.title}" failed (attempt ${attempts}/${job.maxAttempts}), will retry: ${message}`
            : `Transfer of "${job.title}" failed permanently: ${message}`,
        { level: canceled ? 'warn' : willRetry ? 'warn' : 'error', data: { jobId: job.id } },
      );
    } finally {
      // The spool holds full copies of the audio, so it is never left behind
      // once it has served its purpose. `sweepOrphanedSpools` bounds how much is
      // retained for jobs that may still be retried.
      if (!keepSpool) await this.cleanupSpool(job.id);
      downloaded = [];
    }
  }
}

/** Total bytes of the files directly inside a directory. Missing dirs are 0. */
async function directorySize(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const info = await stat(path.join(dir, entry)).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

/**
 * Local spool name for a source file.
 *
 * Keyed on the ino rather than the file's position in the list, so a source that
 * gains or loses a file does not invalidate everything already downloaded. The
 * ino is also unique within an item, which removes the filename-collision
 * problem an index prefix was working around. This name is internal — the
 * filename sent to the receiving server is the sanitized original.
 */
function spoolPathFor(spool: string, file: AbsItemFile): string {
  return path.join(spool, `${sanitize(file.ino)}-${sanitize(file.filename)}`);
}

/**
 * Returns the file's size when it is present and complete, otherwise null.
 *
 * "Complete" means the size matches what the source reports. A partial file left
 * by an interrupted attempt must never be treated as done, or the receiving
 * server gets a truncated chapter. When the source reports no size there is
 * nothing to verify against, so the file is not reused.
 */
async function completeOnDisk(localPath: string, expectedSize: number): Promise<number | null> {
  if (expectedSize <= 0) return null;
  try {
    const existing = await stat(localPath);
    return existing.isFile() && existing.size === expectedSize ? existing.size : null;
  } catch {
    return null;
  }
}

/**
 * Removes spooled files that are not part of the item's current file list, so a
 * source whose files changed between attempts does not leave bytes behind that
 * nothing will ever use.
 */
async function discardStaleSpoolFiles(spool: string, files: readonly AbsItemFile[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(spool);
  } catch {
    return;
  }
  const expected = new Set(files.map((file) => path.basename(spoolPathFor(spool, file))));
  for (const entry of entries) {
    if (expected.has(entry)) continue;
    await rm(path.join(spool, entry), { force: true }).catch(() => undefined);
  }
}

/**
 * Strips path separators, control characters and filesystem-reserved characters
 * from a server-supplied name. Digits, spaces and dashes are preserved -- track
 * numbers live in these filenames and determine playback order.
 */
function sanitize(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    // A leading dot would create a hidden file the ABS scanner skips.
    .replace(/^\.+/, '_')
    .trim();
  return cleaned || 'file';
}

const globalForWorker = globalThis as unknown as { absSyncWorker?: SyncWorker };

export function getWorker(): SyncWorker {
  globalForWorker.absSyncWorker ??= new SyncWorker();
  return globalForWorker.absSyncWorker;
}

// ------------------------------------------------------------------ queries

export async function listJobs(options: { limit?: number; status?: string[] } = {}) {
  return prisma.syncJob.findMany({
    where: options.status?.length ? { status: { in: options.status } } : undefined,
    orderBy: [{ createdAt: 'desc' }],
    take: options.limit ?? 100,
    include: {
      sourceServer: { select: { id: true, name: true } },
      targetServer: { select: { id: true, name: true } },
    },
  });
}

export async function cancelJob(jobId: string): Promise<boolean> {
  const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
  if (!job) return false;

  if (job.status === 'running') {
    // The worker's abort handler writes the terminal state.
    return getWorker().cancel(jobId);
  }
  if (job.status === 'queued') {
    await prisma.syncJob.update({
      where: { id: jobId },
      data: { status: 'canceled', finishedAt: new Date() },
    });
    return true;
  }
  return false;
}

export async function retryJob(jobId: string): Promise<boolean> {
  const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
  if (!job || (job.status !== 'failed' && job.status !== 'canceled')) return false;
  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      status: 'queued',
      phase: 'pending',
      attempts: 0,
      error: null,
      downloadedBytes: 0,
      uploadedBytes: 0,
      finishedAt: null,
    },
  });
  getWorker().wake();
  return true;
}

/**
 * Removes finished transfers from the list, along with any downloaded audio being
 * held for them.
 *
 * A failed transfer keeps its download so a retry need not fetch it again, so
 * clearing the list is also the act of discarding that cache — those bytes can
 * never be reused once the job row is gone. Doing it here rather than leaving the
 * directories to be swept later keeps the disk effect immediate and reportable.
 */
export async function clearFinishedJobs(): Promise<{ count: number; freedBytes: number }> {
  const finished = await prisma.syncJob.findMany({
    where: { status: { in: ['completed', 'failed', 'canceled'] } },
    select: { id: true },
  });
  if (finished.length === 0) return { count: 0, freedBytes: 0 };

  const root = getEnv().spoolDir;
  const worker = getWorker();
  let freedBytes = 0;
  const removable = finished.filter((job) => !worker.isActive(job.id));

  for (const job of removable) {
    const dir = path.join(root, job.id);
    freedBytes += await directorySize(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  const result = await prisma.syncJob.deleteMany({
    where: { id: { in: removable.map((job) => job.id) } },
  });

  if (freedBytes > 0) {
    await logActivity(
      'sync',
      `Cleared ${result.count} finished transfer(s), discarding ${formatBytes(freedBytes)} of ` +
        'downloaded audio that was being kept for retries',
      { level: 'warn' },
    );
  }
  return { count: result.count, freedBytes };
}
