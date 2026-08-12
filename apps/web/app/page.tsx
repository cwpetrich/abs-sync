import { formatBytes } from '@abs-sync/core';
import Link from 'next/link';
import { recentActivity } from '../lib/activity';
import { prisma } from '../lib/db';
import { getIndexManager } from '../lib/index-manager';
import { listServers } from '../lib/servers';
import { AutoRefresh } from './components/auto-refresh';
import { Callout, EmptyState, PageHeader, Pill, RelativeTime, Stat } from './components/ui';
import { IndexAllButton } from './index-all-button';

export const dynamic = 'force-dynamic';

const LEVEL_TONE = { info: 'neutral', warn: 'warn', error: 'danger' } as const;

export default async function Overview() {
  const [servers, activity, jobCounts, watchCount, pendingBytes] = await Promise.all([
    listServers(),
    recentActivity(25),
    prisma.syncJob.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.seriesWatch.count({ where: { enabled: true } }),
    prisma.syncJob.aggregate({
      where: { status: { in: ['queued', 'running'] } },
      _sum: { totalBytes: true },
    }),
  ]);

  const counts = new Map(jobCounts.map((row) => [row.status, row._count._all]));
  const target = servers.find((server) => server.isTarget) ?? null;
  const sources = servers.filter((server) => !server.isTarget);
  const totalIndexed = servers.reduce((sum, server) => sum + server.itemCount, 0);
  const indexing = getIndexManager().status();
  const neverIndexed = servers.filter((server) => server.enabled && !server.lastIndexedAt);

  if (servers.length === 0) {
    return (
      <>
        <PageHeader title="abs-sync" />
        <EmptyState
          title="Let’s connect your first server"
          description="Add your own Audiobookshelf server and mark it as the sync target, then add the servers you want to compare against. Nothing is transferred until you ask for it."
          action={
            <Link href="/servers" className="btn btn-primary">
              Add a server
            </Link>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Overview"
        description="Where your libraries stand relative to everyone else's."
        actions={
          <>
            <IndexAllButton serverIds={servers.filter((s) => s.enabled).map((s) => s.id)} />
            <Link href="/compare" className="btn btn-primary">
              Compare libraries
            </Link>
          </>
        }
      />

      {indexing.length > 0 ? <AutoRefresh intervalMs={3000} /> : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="My server"
          value={target ? target.name : '—'}
          hint={target ? `${target.itemCount.toLocaleString()} books indexed` : 'not set yet'}
          tone={target ? 'default' : 'warn'}
        />
        <Stat
          label="Other servers"
          value={sources.length}
          hint={`${totalIndexed.toLocaleString()} books indexed in total`}
        />
        <Stat
          label="In the queue"
          value={(counts.get('queued') ?? 0) + (counts.get('running') ?? 0)}
          hint={
            pendingBytes._sum.totalBytes
              ? `${formatBytes(pendingBytes._sum.totalBytes)} to move`
              : 'nothing pending'
          }
          tone={(counts.get('running') ?? 0) > 0 ? 'ok' : 'default'}
        />
        <Stat
          label="Watched series"
          value={watchCount}
          hint={`${counts.get('failed') ?? 0} failed transfer(s)`}
          tone={(counts.get('failed') ?? 0) > 0 ? 'danger' : 'default'}
        />
      </div>

      <div className="mb-6 space-y-3">
        {!target ? (
          <Callout tone="warn" title="No sync target">
            Mark one of your servers as “mine” on the{' '}
            <Link href="/servers" className="underline">
              servers page
            </Link>{' '}
            — that is where books get synced into.
          </Callout>
        ) : null}

        {target && !target.canUpload ? (
          <Callout tone="danger" title="Target cannot receive uploads">
            The account behind {target.name}’s credential lacks the upload permission, so every
            transfer will fail. Grant it upload rights in Audiobookshelf, or use an admin API key.
          </Callout>
        ) : null}

        {neverIndexed.length > 0 ? (
          <Callout tone="info" title="Not indexed yet">
            {neverIndexed.map((server) => server.name).join(', ')} ha
            {neverIndexed.length === 1 ? 's' : 've'} never been indexed. Comparisons only use cached
            index data, so run an index first.
          </Callout>
        ) : null}

        {servers
          .filter((server) => server.lastError)
          .map((server) => (
            <Callout key={server.id} tone="danger" title={`${server.name} reported a problem`}>
              {server.lastError}
            </Callout>
          ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">Servers</h2>
          <ul className="card overflow-hidden">
            {servers.map((server) => {
              const running = indexing.find((status) => status.serverId === server.id);
              return (
                <li
                  key={server.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-line)] px-4 py-2.5 first:border-t-0"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{server.name}</span>
                      {server.isTarget ? <Pill tone="accent">mine</Pill> : null}
                      {!server.enabled ? <Pill tone="warn">off</Pill> : null}
                    </div>
                    <p className="text-xs text-[var(--color-ink-faint)]">
                      {running ? (
                        <span className="text-[var(--color-accent)]">
                          indexing… {running.itemsIndexed.toLocaleString()} books
                        </span>
                      ) : (
                        <>
                          {server.itemCount.toLocaleString()} books · indexed{' '}
                          <RelativeTime date={server.lastIndexedAt} />
                        </>
                      )}
                    </p>
                  </div>
                  <Link href="/servers" className="btn btn-sm">
                    Manage
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">Recent activity</h2>
          {activity.length === 0 ? (
            <div className="card px-4 py-6 text-center text-sm text-[var(--color-ink-muted)]">
              Nothing has happened yet.
            </div>
          ) : (
            <ul className="card divide-y divide-[var(--color-line)] overflow-hidden">
              {activity.map((entry) => (
                <li key={entry.id} className="flex items-start gap-3 px-4 py-2">
                  <Pill tone={LEVEL_TONE[entry.level as keyof typeof LEVEL_TONE] ?? 'neutral'}>
                    {entry.kind}
                  </Pill>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{entry.message}</p>
                    <p className="text-xs text-[var(--color-ink-faint)]">
                      <RelativeTime date={entry.at} />
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
