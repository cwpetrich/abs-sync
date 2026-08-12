/**
 * Starts the background transfer worker and the watch scheduler when the server
 * boots. Guarded to the Node runtime — neither can run on the edge, since they
 * need the filesystem and a SQLite connection.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Skip during `next build`, which also evaluates this module.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { getWorker } = await import('./lib/sync-worker');
  const { getScheduler } = await import('./lib/scheduler');
  const { loadSettings } = await import('./lib/settings');

  try {
    // Before anything reads configuration: the worker's concurrency limit and
    // the scheduler's interval are both read at start(), so loading overrides
    // afterwards would run the first pass on environment defaults.
    await loadSettings();

    getWorker().start();
    getScheduler().start();
    console.log('[abs-sync] transfer worker and watch scheduler started');
  } catch (error) {
    // A misconfigured env (e.g. missing ABS_SYNC_SECRET) must not crash the
    // server — the settings UI needs to load so the user can see the problem.
    console.error(
      '[abs-sync] background services did not start:',
      error instanceof Error ? error.message : error,
    );
  }
}
