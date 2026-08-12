import { formatBytes } from '@abs-sync/core';
import { prisma } from '../../lib/db';
import { getEnv } from '../../lib/env';
import { mattermostMode } from '../../lib/notify-mattermost';
import { Callout, LocalTime, PageHeader, Pill } from '../components/ui';
import { NotificationsPanel } from './notifications-panel';

export const dynamic = 'force-dynamic';

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-[var(--color-line)] px-4 py-2.5 first:border-t-0">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint ? <div className="text-xs text-[var(--color-ink-faint)]">{hint}</div> : null}
      </div>
      <div className="font-mono text-sm text-[var(--color-ink-muted)]">{value}</div>
    </div>
  );
}

export default async function SettingsPage() {
  let env: ReturnType<typeof getEnv> | null = null;
  let envError: string | null = null;
  try {
    env = getEnv();
  } catch (error) {
    envError = error instanceof Error ? error.message : String(error);
  }

  const [indexRuns, itemCount, jobCount, subscriptionCount] = await Promise.all([
    prisma.indexRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 10,
      include: { server: { select: { name: true } } },
    }),
    prisma.indexedItem.count(),
    prisma.syncJob.count(),
    prisma.pushSubscription.count(),
  ]);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Configuration comes from environment variables so it stays reproducible in a container. Edit .env and restart to change anything here."
      />

      {envError ? (
        <div className="mb-6">
          <Callout tone="danger" title="Configuration problem">
            {envError}
          </Callout>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">Configuration</h2>
          <div className="card overflow-hidden">
            <Row
              label="Database"
              value={env?.databaseUrl ?? '—'}
              hint="DATABASE_URL — SQLite file holding servers, index and jobs"
            />
            <Row
              label="Credential encryption"
              value={env ? <Pill tone="ok">configured</Pill> : <Pill tone="danger">missing</Pill>}
              hint="ABS_SYNC_SECRET — AES-256-GCM key material for stored credentials"
            />
            <Row
              label="Spool directory"
              value={env?.spoolDir ?? '—'}
              hint="ABS_SYNC_SPOOL_DIR — needs room for the largest item you sync"
            />
            <Row
              label="Concurrent transfers"
              value={env?.maxConcurrentSyncs ?? '—'}
              hint="ABS_SYNC_MAX_CONCURRENT"
            />
            <Row
              label="Watch interval"
              value={env ? `${env.watchIntervalMinutes} min` : '—'}
              hint="ABS_SYNC_WATCH_INTERVAL_MINUTES — how often watched series are re-checked"
            />
            <Row
              label="Per-item size limit"
              value={env ? formatBytes(env.maxItemSizeBytes) : '—'}
              hint="ABS_SYNC_MAX_ITEM_BYTES — transfers larger than this are refused"
            />
            <Row
              label="Require HTTPS"
              value={env?.requireHttps ? 'yes' : 'no'}
              hint="ABS_SYNC_REQUIRE_HTTPS — reject plain-http server URLs except localhost"
            />
          </div>

          <h2 className="mb-2 mt-6 text-sm font-medium text-[var(--color-ink-muted)]">
            Notifications
          </h2>
          <NotificationsPanel
            vapidPublicKey={env?.vapidPublicKey ?? null}
            mattermost={env ? mattermostMode() : null}
            mattermostChannel={env?.mattermostChannel ?? null}
            subscriptionCount={subscriptionCount}
          />

          <div className="mt-4">
            <Callout tone="warn" title="This app has no login">
              abs-sync is a single-tenant admin tool and holds credentials for every server you add.
              Run it on a trusted network, or behind a reverse proxy that requires authentication.
              Server Actions are reachable by direct POST, so do not expose it to the internet
              unguarded.
            </Callout>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">State</h2>
          <div className="card overflow-hidden">
            <Row label="Indexed books" value={itemCount.toLocaleString()} />
            <Row label="Transfer records" value={jobCount.toLocaleString()} />
          </div>

          <h2 className="mb-2 mt-6 text-sm font-medium text-[var(--color-ink-muted)]">
            Recent index runs
          </h2>
          {indexRuns.length === 0 ? (
            <div className="card px-4 py-6 text-center text-sm text-[var(--color-ink-muted)]">
              No index runs yet.
            </div>
          ) : (
            <ul className="card overflow-hidden">
              {indexRuns.map((run) => (
                <li
                  key={run.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-line)] px-4 py-2.5 first:border-t-0"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm">{run.server.name}</span>
                      <Pill
                        tone={
                          run.status === 'completed'
                            ? 'ok'
                            : run.status === 'failed'
                              ? 'danger'
                              : run.status === 'canceled'
                                ? 'neutral'
                                : 'accent'
                        }
                      >
                        {run.status}
                      </Pill>
                      <Pill tone={run.mode === 'full' ? 'info' : 'neutral'}>{run.mode}</Pill>
                    </div>
                    <p className="text-xs text-[var(--color-ink-faint)]">
                      <LocalTime date={run.startedAt} /> · {run.itemsIndexed.toLocaleString()} indexed
                      {run.itemsRemoved > 0 ? `, ${run.itemsRemoved} removed` : ''}
                    </p>
                    {run.error ? (
                      <p className="mt-0.5 text-xs text-[var(--color-danger)]">{run.error}</p>
                    ) : null}
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
