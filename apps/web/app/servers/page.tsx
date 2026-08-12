import { getIndexManager } from '../../lib/index-manager';
import { listServers } from '../../lib/servers';
import { PageHeader } from '../components/ui';
import { ServerCard } from './server-card';
import { ServerForm } from './server-form';
import { AutoRefresh } from '../components/auto-refresh';

export const dynamic = 'force-dynamic';

export default async function ServersPage() {
  const servers = await listServers();
  const indexing = getIndexManager().status();
  const indexingById = new Map(indexing.map((status) => [status.serverId, status]));

  return (
    <>
      <PageHeader
        title="Servers"
        description="Your own Audiobookshelf server plus every server you have been given access to. Books are only ever pulled from a server you hold a credential for."
      />

      {/* Refresh while an index is running so counts advance without a manual reload. */}
      {indexing.length > 0 ? <AutoRefresh intervalMs={3000} /> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          {servers.length === 0 ? (
            <div className="card px-6 py-12 text-center">
              <p className="font-medium">No servers yet</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-[var(--color-ink-muted)]">
                Start by adding your own server and marking it as the sync target, then add a
                friend’s server to compare against.
              </p>
            </div>
          ) : (
            servers.map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                indexing={indexingById.get(server.id) ?? null}
              />
            ))
          )}
        </div>

        <div className="lg:sticky lg:top-20 lg:self-start">
          <ServerForm hasTarget={servers.some((server) => server.isTarget)} />
        </div>
      </div>
    </>
  );
}
