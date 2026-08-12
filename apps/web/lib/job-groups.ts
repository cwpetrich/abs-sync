/**
 * Collapses transfer rows so one book is one entry in the Transfers list.
 *
 * A book can accumulate several rows: a watch queued it, it was cancelled, it
 * was queued again from a different friend's server, it failed and was retried.
 * Showing every one of them side by side makes "retry this book" ambiguous —
 * which row has the download? which is the live one? So attempts are grouped and
 * only the one that matters is actionable.
 *
 * Pure, so both the client component and the test suite can use it.
 */

export interface GroupableJob {
  id: string;
  status: string;
  title: string;
  author: string | null;
  /** Normalized identity as stored on the job, when available. */
  normTitle?: string;
  normAuthor?: string;
  /** True when downloaded audio is still held for this attempt. */
  hasDownload?: boolean;
  createdAt: string;
}

export interface JobGroup<T extends GroupableJob> {
  key: string;
  /** The attempt the row represents and acts on. */
  primary: T;
  /** Superseded attempts, newest first. */
  superseded: T[];
  /** True when any attempt is queued or running. */
  live: boolean;
}

/** Lower is more interesting: a live attempt outranks a finished one. */
const STATUS_RANK: Record<string, number> = {
  running: 0,
  queued: 1,
  completed: 2,
  failed: 3,
  canceled: 4,
};

function rankOf(status: string): number {
  return STATUS_RANK[status] ?? 5;
}

function identityOf(job: GroupableJob): string {
  const title = job.normTitle?.trim() || job.title.trim().toLowerCase();
  const author = job.normAuthor?.trim() || (job.author ?? '').trim().toLowerCase();
  return `${title}|${author}`;
}

/**
 * Groups by book identity, newest group first.
 *
 * The primary attempt is the live one if there is one, then the most recently
 * finished — except that a completed attempt always wins over a failed or
 * cancelled one, since the book did arrive and the row should say so.
 */
export function groupJobs<T extends GroupableJob>(jobs: readonly T[]): Array<JobGroup<T>> {
  const groups = new Map<string, T[]>();
  for (const job of jobs) {
    const key = identityOf(job);
    const bucket = groups.get(key);
    if (bucket) bucket.push(job);
    else groups.set(key, [job]);
  }

  const result: Array<JobGroup<T>> = [];
  for (const [key, attempts] of groups) {
    const ordered = [...attempts].sort((a, b) => {
      const byStatus = rankOf(a.status) - rankOf(b.status);
      if (byStatus !== 0) return byStatus;
      return b.createdAt.localeCompare(a.createdAt);
    });
    const primary = ordered[0]!;
    result.push({
      key,
      primary,
      superseded: ordered.slice(1),
      live: attempts.some((job) => job.status === 'queued' || job.status === 'running'),
    });
  }

  // Newest activity first, matching the order the rows arrived in.
  result.sort((a, b) => b.primary.createdAt.localeCompare(a.primary.createdAt));
  return result;
}

/**
 * Which attempt a retry should act on: the one still holding downloaded audio,
 * so the retry uploads what is on disk instead of fetching gigabytes again.
 */
export function retryTargetOf<T extends GroupableJob>(group: JobGroup<T>): T {
  if (group.primary.hasDownload) return group.primary;
  return group.superseded.find((job) => job.hasDownload) ?? group.primary;
}
