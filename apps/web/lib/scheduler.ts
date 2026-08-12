import { describeError, logActivity, pruneActivity } from './activity';
import { getEnv } from './env';
import { indexAllServers } from './indexer';
import { getWorker } from './sync-worker';
import { evaluateAllWatches } from './watches';

export interface SchedulerRunResult {
  startedAt: Date;
  finishedAt: Date;
  serversIndexed: number;
  itemsIndexed: number;
  watchesEvaluated: number;
  booksQueued: number;
  errors: string[];
}

/**
 * Periodic background pass: refresh every server's index, then let each watched
 * series queue anything new. Indexing runs first so watches always evaluate
 * against current data.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRun: SchedulerRunResult | null = null;

  get isRunning(): boolean {
    return this.running;
  }

  get lastResult(): SchedulerRunResult | null {
    return this.lastRun;
  }

  /** The interval the current timer was created with, in ms. */
  private timerIntervalMs: number | null = null;

  start(): void {
    if (this.timer) return;
    const intervalMs = getEnv().watchIntervalMinutes * 60_000;
    this.timer = setInterval(() => {
      void this.runNow();
    }, intervalMs);
    this.timer.unref?.();
    this.timerIntervalMs = intervalMs;
    // No immediate run on boot: a restart loop would otherwise hammer every
    // remote server. The first pass happens one interval in.
  }

  /**
   * Picks up a changed interval without a restart.
   *
   * `setInterval` fixes its period at creation, so a interval edited in
   * Settings would otherwise keep firing at the old rate until the process
   * restarted — the exact "I changed it and nothing happened" this app tries
   * to avoid. Rescheduling restarts the countdown, which is also why it is a
   * no-op when the interval has not actually changed: repeatedly saving an
   * unrelated setting would otherwise keep postponing the next pass forever.
   */
  reschedule(): void {
    if (!this.timer) return;
    const intervalMs = getEnv().watchIntervalMinutes * 60_000;
    if (intervalMs === this.timerIntervalMs) return;
    this.stop();
    this.start();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.timerIntervalMs = null;
  }

  /** Runs a pass now. Concurrent calls collapse into the in-flight one. */
  async runNow(): Promise<SchedulerRunResult> {
    if (this.running && this.lastRun) return this.lastRun;
    this.running = true;
    const startedAt = new Date();
    const errors: string[] = [];
    let serversIndexed = 0;
    let itemsIndexed = 0;
    let watchesEvaluated = 0;
    let booksQueued = 0;

    try {
      const summaries = await indexAllServers();
      serversIndexed = summaries.filter((summary) => summary.status === 'completed').length;
      itemsIndexed = summaries.reduce((sum, summary) => sum + summary.itemsIndexed, 0);
      for (const summary of summaries) {
        if (summary.error) errors.push(`${summary.serverName}: ${summary.error}`);
      }

      const evaluations = await evaluateAllWatches();
      watchesEvaluated = evaluations.length;
      booksQueued = evaluations.reduce((sum, evaluation) => sum + evaluation.enqueued, 0);
      for (const evaluation of evaluations) {
        if (evaluation.error) errors.push(`watch "${evaluation.seriesName}": ${evaluation.error}`);
      }

      if (booksQueued > 0) getWorker().wake();
      await pruneActivity();
    } catch (error) {
      const message = describeError(error);
      errors.push(message);
      await logActivity('system', `Scheduled run failed: ${message}`, { level: 'error' });
    } finally {
      this.running = false;
    }

    const result: SchedulerRunResult = {
      startedAt,
      finishedAt: new Date(),
      serversIndexed,
      itemsIndexed,
      watchesEvaluated,
      booksQueued,
      errors,
    };
    this.lastRun = result;

    if (booksQueued > 0 || errors.length > 0) {
      await logActivity(
        'system',
        `Scheduled run: indexed ${itemsIndexed} books across ${serversIndexed} server(s), ` +
          `queued ${booksQueued} book(s) from ${watchesEvaluated} watch(es)` +
          (errors.length > 0 ? `, ${errors.length} problem(s)` : ''),
        { level: errors.length > 0 ? 'warn' : 'info' },
      );
    }

    return result;
  }
}

const globalForScheduler = globalThis as unknown as { absSyncScheduler?: Scheduler };

export function getScheduler(): Scheduler {
  globalForScheduler.absSyncScheduler ??= new Scheduler();
  return globalForScheduler.absSyncScheduler;
}
