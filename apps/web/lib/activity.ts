import { prisma } from './db';

export type ActivityKind = 'index' | 'sync' | 'watch' | 'server' | 'system';
export type ActivityLevel = 'info' | 'warn' | 'error';

/**
 * Appends to the activity trail. Never throws: losing a log line must not fail
 * the operation being logged, especially inside the background worker.
 */
export async function logActivity(
  kind: ActivityKind,
  message: string,
  options: { level?: ActivityLevel; data?: unknown } = {},
): Promise<void> {
  const level = options.level ?? 'info';
  try {
    await prisma.activityLog.create({
      data: {
        kind,
        message: message.slice(0, 2000),
        level,
        dataJson: options.data === undefined ? null : JSON.stringify(options.data),
      },
    });
  } catch (error) {
    console.error('[abs-sync] failed to write activity log:', error);
  }

  // Raised after the row is written and deliberately not awaited: a slow or
  // unreachable webhook must not add its timeout to a transfer's critical path,
  // and the trail in the database is the durable record either way. Imported
  // lazily so this module stays free of the transport dependencies — `web-push`
  // has no business loading in a process that only reads the log.
  try {
    const { getNotifier } = await import('./notify');
    getNotifier().push({ kind, level, message });
  } catch (error) {
    console.error('[abs-sync] failed to raise notification:', error);
  }
}

export async function recentActivity(limit = 100) {
  return prisma.activityLog.findMany({ orderBy: { at: 'desc' }, take: limit });
}

/** Trims the log so a long-running install does not grow without bound. */
export async function pruneActivity(keep = 5000): Promise<number> {
  const cutoff = await prisma.activityLog.findMany({
    orderBy: { at: 'desc' },
    skip: keep,
    take: 1,
    select: { at: true },
  });
  const oldest = cutoff[0]?.at;
  if (!oldest) return 0;
  const result = await prisma.activityLog.deleteMany({ where: { at: { lt: oldest } } });
  return result.count;
}

/** Renders an unknown thrown value as a single readable line. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (caused by: ${error.cause.message})` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}
