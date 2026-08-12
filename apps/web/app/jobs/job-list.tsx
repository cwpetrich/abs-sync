'use client';

import { formatBytes } from '@abs-sync/core';
import { useState, useTransition } from 'react';
import { groupJobs, retryTargetOf, type JobGroup } from '../../lib/job-groups';
import { cancelJobAction, clearFinishedJobsAction, retryJobAction } from '../actions';
import { Callout, Pill, Progress, RelativeTime, type PillTone } from '../components/ui';

export interface JobView {
  id: string;
  status: string;
  phase: string;
  title: string;
  author: string | null;
  series: string | null;
  normTitle: string;
  normAuthor: string;
  /** Downloaded audio still held for this attempt, so a retry skips the download. */
  hasDownload: boolean;
  sourceName: string;
  targetName: string;
  totalBytes: number | null;
  downloadedBytes: number;
  uploadedBytes: number;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  origin: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const STATUS_TONE: Record<string, PillTone> = {
  queued: 'info',
  running: 'accent',
  completed: 'ok',
  failed: 'danger',
  canceled: 'neutral',
};

function progressFor(job: JobView): { value: number; max: number; label: string } | null {
  if (job.status !== 'running' || !job.totalBytes) return null;
  if (job.phase === 'uploading') {
    return {
      value: job.uploadedBytes,
      max: job.totalBytes,
      label: `Uploading ${formatBytes(job.uploadedBytes)} of ${formatBytes(job.totalBytes)}`,
    };
  }
  return {
    value: job.downloadedBytes,
    max: job.totalBytes,
    label: `Downloading ${formatBytes(job.downloadedBytes)} of ${formatBytes(job.totalBytes)}`,
  };
}

function JobRow({ group }: { group: JobGroup<JobView> }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showAttempts, setShowAttempts] = useState(false);
  const job = group.primary;
  const progress = progressFor(job);
  // Retrying acts on whichever attempt still holds the download, which is not
  // always the newest one.
  const retryTarget = retryTargetOf(group);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? 'Failed');
    });
  }

  return (
    <li className="border-t border-[var(--color-line)] px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-56 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{job.title}</span>
            <Pill tone={STATUS_TONE[job.status] ?? 'neutral'}>
              {job.status === 'running' ? job.phase : job.status}
            </Pill>
            {job.origin === 'watch' ? <Pill tone="info">auto</Pill> : null}
            {job.attempts > 1 ? (
              <Pill tone="warn">
                attempt {job.attempts}/{job.maxAttempts}
              </Pill>
            ) : null}
          </div>
          <p className="text-sm text-[var(--color-ink-muted)]">
            {job.author ?? 'Unknown author'}
            {job.series ? ` · ${job.series}` : ''}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
            {job.sourceName} → {job.targetName} ·{' '}
            {job.totalBytes ? formatBytes(job.totalBytes) : 'size unknown'} ·{' '}
            <RelativeTime date={job.finishedAt ?? job.startedAt ?? job.createdAt} />
            {retryTarget.hasDownload && job.status !== 'completed'
              ? ' · download kept, a retry uploads it without fetching again'
              : ''}
          </p>
        </div>

        <div className="flex gap-2">
          {job.status === 'queued' || job.status === 'running' ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={pending}
              onClick={() => run(() => cancelJobAction(job.id))}
            >
              Cancel
            </button>
          ) : null}
          {job.status === 'failed' || job.status === 'canceled' ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={pending}
              onClick={() => run(() => retryJobAction(retryTarget.id))}
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>

      {progress ? (
        <div className="mt-2">
          <Progress value={progress.value} max={progress.max} label={progress.label} />
          <p className="mt-1 text-xs text-[var(--color-ink-faint)] tabular-nums">{progress.label}</p>
        </div>
      ) : null}

      {job.error ? (
        <p className="mt-2 text-xs text-[var(--color-danger)]">{job.error}</p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-[var(--color-danger)]">{error}</p> : null}

      {group.superseded.length > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            className="text-xs text-[var(--color-ink-faint)] underline underline-offset-2"
            onClick={() => setShowAttempts((open) => !open)}
          >
            {showAttempts ? 'Hide' : 'Show'} {group.superseded.length} earlier attempt
            {group.superseded.length === 1 ? '' : 's'}
          </button>
          {showAttempts ? (
            <ul className="mt-1 space-y-1">
              {group.superseded.map((attempt) => (
                <li key={attempt.id} className="text-xs text-[var(--color-ink-faint)]">
                  {attempt.status} · {attempt.sourceName} → {attempt.targetName} ·{' '}
                  <RelativeTime date={attempt.finishedAt ?? attempt.createdAt} />
                  {attempt.error ? ` · ${attempt.error.split('\n')[0]}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function JobList({ jobs }: { jobs: JobView[] }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const groups = groupJobs(jobs);
  const active = groups.filter((group) => group.live);
  const finished = groups.filter((group) => !group.live);

  function clearFinished() {
    startTransition(async () => {
      const result = await clearFinishedJobsAction();
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      // Say so when clearing threw away downloads a retry could have reused.
      setMessage(
        result.data.freedBytes > 0
          ? `Cleared ${result.data.count} finished transfer(s), discarding ${formatBytes(
              result.data.freedBytes,
            )} of downloaded audio that was kept for retries`
          : `Cleared ${result.data.count} finished transfer(s)`,
      );
    });
  }

  return (
    <div className="space-y-6">
      {message ? <Callout tone="info">{message}</Callout> : null}

      <section>
        <h2 className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">
          Active ({active.length})
        </h2>
        {active.length === 0 ? (
          <div className="card px-4 py-6 text-center text-sm text-[var(--color-ink-muted)]">
            Nothing in the queue.
          </div>
        ) : (
          <ul className="card overflow-hidden">
            {active.map((group) => (
              <JobRow key={group.key} group={group} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium text-[var(--color-ink-muted)]">
            History ({finished.length})
          </h2>
          {finished.length > 0 ? (
            <button type="button" className="btn btn-sm" disabled={pending} onClick={clearFinished}>
              Clear history
            </button>
          ) : null}
        </div>
        {finished.length === 0 ? (
          <div className="card px-4 py-6 text-center text-sm text-[var(--color-ink-muted)]">
            No completed transfers yet.
          </div>
        ) : (
          <ul className="card overflow-hidden">
            {finished.map((group) => (
              <JobRow key={group.key} group={group} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
