import { describeError } from './activity';
import { indexServer, type IndexMode, type IndexSummary } from './indexer';

interface RunningIndex {
  serverId: string;
  controller: AbortController;
  startedAt: Date;
  itemsIndexed: number;
  mode: IndexMode;
}

export interface IndexStatus {
  serverId: string;
  startedAt: string;
  itemsIndexed: number;
  /** What was requested; the run may still escalate to a full crawl. */
  mode: IndexMode;
}

/**
 * Owns in-flight indexing runs.
 *
 * Indexing a large library takes minutes, which is far longer than a request
 * should live. Runs are therefore owned by this process-level singleton and the
 * UI polls for status, rather than being awaited inside a server action.
 */
export class IndexManager {
  private readonly running = new Map<string, RunningIndex>();
  private readonly lastSummaries = new Map<string, IndexSummary>();

  /** Starts an index run unless one is already active for this server. */
  start(serverId: string, mode: IndexMode = 'auto'): { started: boolean; reason?: string } {
    if (this.running.has(serverId)) {
      return { started: false, reason: 'An index is already running for this server' };
    }

    const controller = new AbortController();
    const entry: RunningIndex = {
      serverId,
      controller,
      startedAt: new Date(),
      itemsIndexed: 0,
      mode,
    };
    this.running.set(serverId, entry);

    void indexServer(serverId, {
      mode,
      signal: controller.signal,
      onProgress: (indexed) => {
        entry.itemsIndexed = indexed;
      },
    })
      .then((summary) => {
        this.lastSummaries.set(serverId, summary);
      })
      .catch((error: unknown) => {
        console.error(`[abs-sync] index run for ${serverId} crashed:`, describeError(error));
      })
      .finally(() => {
        this.running.delete(serverId);
      });

    return { started: true };
  }

  cancel(serverId: string): boolean {
    const entry = this.running.get(serverId);
    if (!entry) return false;
    entry.controller.abort(new DOMException('Index canceled', 'AbortError'));
    return true;
  }

  isRunning(serverId: string): boolean {
    return this.running.has(serverId);
  }

  status(): IndexStatus[] {
    return [...this.running.values()].map((entry) => ({
      serverId: entry.serverId,
      startedAt: entry.startedAt.toISOString(),
      itemsIndexed: entry.itemsIndexed,
      mode: entry.mode,
    }));
  }

  lastSummary(serverId: string): IndexSummary | null {
    return this.lastSummaries.get(serverId) ?? null;
  }
}

const globalForIndex = globalThis as unknown as { absSyncIndexManager?: IndexManager };

export function getIndexManager(): IndexManager {
  globalForIndex.absSyncIndexManager ??= new IndexManager();
  return globalForIndex.absSyncIndexManager;
}
