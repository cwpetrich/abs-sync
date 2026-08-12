import { getEnv } from '../../lib/env';
import { listJobs } from '../../lib/sync-worker';
import { AutoRefresh } from '../components/auto-refresh';
import { Callout, PageHeader } from '../components/ui';
import { JobList, type JobView } from './job-list';

export const dynamic = 'force-dynamic';

export default async function JobsPage() {
  const jobs = await listJobs({ limit: 200 });

  const views: JobView[] = jobs.map((job) => ({
    id: job.id,
    status: job.status,
    phase: job.phase,
    title: job.title,
    author: job.author,
    series: job.series,
    normTitle: job.normTitle,
    normAuthor: job.normAuthor,
    hasDownload: job.spoolPath !== null,
    sourceName: job.sourceServer.name,
    targetName: job.targetServer.name,
    totalBytes: job.totalBytes,
    downloadedBytes: job.downloadedBytes,
    uploadedBytes: job.uploadedBytes,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.error,
    origin: job.origin,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  }));

  const hasActive = views.some((job) => job.status === 'queued' || job.status === 'running');

  let concurrency = 0;
  let spoolDir = '';
  try {
    const env = getEnv();
    concurrency = env.maxConcurrentSyncs;
    spoolDir = env.spoolDir;
  } catch {
    // Settings page reports configuration problems; don't break this view.
  }

  return (
    <>
      <PageHeader
        title="Transfers"
        description={
          <>
            Each transfer downloads the original audio files from the source server to{' '}
            <code className="text-[var(--color-ink)]">{spoolDir || 'the spool directory'}</code>, then
            uploads them to your server. {concurrency > 0 ? `${concurrency} run at a time.` : ''}
          </>
        }
      />

      {hasActive ? <AutoRefresh intervalMs={2500} /> : null}

      {views.length === 0 ? (
        <Callout tone="info">
          No transfers yet. Head to Compare, pick some books, and press Sync.
        </Callout>
      ) : (
        <JobList jobs={views} />
      )}
    </>
  );
}
