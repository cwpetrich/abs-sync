import { prisma } from '../../lib/db';
import { getEnv } from '../../lib/env';
import { getTargetServer } from '../../lib/servers';
import { listWatches, suggestSeriesToWatch } from '../../lib/watches';
import { PageHeader } from '../components/ui';
import { RunSchedulerButton } from './run-scheduler-button';
import { WatchPanel } from './watch-panel';

export const dynamic = 'force-dynamic';

export default async function WatchesPage() {
  const [watches, suggestions, target, sources] = await Promise.all([
    listWatches(),
    suggestSeriesToWatch(15),
    getTargetServer(),
    prisma.server.findMany({
      where: { enabled: true, isTarget: false },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const libraries = (target?.libraries ?? []).filter((library) => library.included);

  let intervalMinutes = 0;
  try {
    intervalMinutes = getEnv().watchIntervalMinutes;
  } catch {
    // Configuration problems surface on the settings page.
  }

  return (
    <>
      <PageHeader
        title="Watched series"
        description={
          intervalMinutes > 0
            ? `Checked automatically every ${intervalMinutes} minutes: sources are re-indexed, then anything new in a watched series is queued.`
            : 'Watched series are checked on a schedule: sources are re-indexed, then anything new is queued.'
        }
        actions={<RunSchedulerButton />}
      />

      <WatchPanel
        watches={watches}
        suggestions={suggestions}
        libraries={libraries.map((library) => ({ id: library.id, name: library.name }))}
        sources={sources}
        canWatch={libraries.length > 0}
      />
    </>
  );
}
