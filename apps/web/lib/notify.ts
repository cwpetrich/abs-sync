import type { ActivityKind, ActivityLevel } from './activity';
import { getEnv } from './env';
import { mattermostMode, sendMattermost } from './notify-mattermost';
import { sendWebPush } from './notify-push';

/**
 * Outbound notifications.
 *
 * Every notable thing this app does already passes through `logActivity`, so
 * that is the single place notifications are raised from — no call site has to
 * remember to also notify, and anything added later is covered for free.
 *
 * The hard part is not delivery, it is volume. One watch pass legitimately
 * writes twenty activity lines: seven "auto-queued", seven "synced", and a
 * warning per source item whose file list is duplicated. Sending twenty pushes
 * for one pass is how a notification channel gets muted, and a muted channel is
 * worse than none because it reads as working. So:
 *
 *  - **Errors go out immediately.** They are rare and time-sensitive.
 *  - **Everything else is batched** into one message per digest window.
 *  - **Routine indexing is dropped.** An hourly "indexed 0 new books" is not
 *    news, and it would otherwise be the overwhelming majority of traffic.
 */

export interface NotifyEvent {
  kind: ActivityKind;
  level: ActivityLevel;
  message: string;
}

/** A rendered notification, as handed to each transport. */
export interface Notification {
  title: string;
  body: string;
  level: ActivityLevel;
  /** Absolute link to the most relevant page, when one is configured. */
  url: string | null;
}

/** Where in the app each kind of event is best inspected. */
const PATH_FOR_KIND: Record<ActivityKind, string> = {
  index: '/settings',
  sync: '/jobs',
  watch: '/watches',
  server: '/servers',
  system: '/',
};

/**
 * Whether an event is worth sending at all.
 *
 * Routine index chatter is dropped: incremental runs happen every hour per
 * server and almost always report nothing. Their failures still get through,
 * because those arrive as `warn` or `error`.
 */
export function isNotifiable(event: NotifyEvent): boolean {
  if (event.kind === 'index' && event.level === 'info') return false;
  return true;
}

/** Errors interrupt; everything else waits for the next digest. */
export function isImmediate(event: NotifyEvent): boolean {
  return event.level === 'error';
}

const TITLE_FOR_KIND: Record<ActivityKind, string> = {
  index: 'Indexing',
  sync: 'Transfer',
  watch: 'Watched series',
  server: 'Server',
  system: 'abs-sync',
};

/** How many individual lines a digest spells out before summarising the rest. */
const MAX_DIGEST_LINES = 8;

/**
 * Renders a batch as one notification.
 *
 * A single event keeps its own message as the body, so the common case reads
 * like a normal alert rather than a report with one row.
 */
export function renderDigest(events: NotifyEvent[]): Notification | null {
  if (events.length === 0) return null;

  const worst: ActivityLevel = events.some((event) => event.level === 'error')
    ? 'error'
    : events.some((event) => event.level === 'warn')
      ? 'warn'
      : 'info';

  const first = events[0]!;
  const url = linkFor(first.kind);

  if (events.length === 1) {
    return { title: TITLE_FOR_KIND[first.kind], body: first.message, level: worst, url };
  }

  const shown = events.slice(0, MAX_DIGEST_LINES);
  const remaining = events.length - shown.length;
  const body =
    shown.map((event) => `• ${event.message}`).join('\n') +
    (remaining > 0 ? `\n• …and ${remaining} more` : '');

  // Name the dominant kind rather than "abs-sync", so a glance at the title is
  // enough to know whether this needs attention now.
  const kinds = new Set(events.map((event) => event.kind));
  const title =
    kinds.size === 1
      ? `${TITLE_FOR_KIND[first.kind]} · ${events.length} updates`
      : `abs-sync · ${events.length} updates`;

  return { title, body, level: worst, url };
}

function linkFor(kind: ActivityKind): string | null {
  const { publicUrl } = getEnv();
  return publicUrl ? `${publicUrl}${PATH_FOR_KIND[kind]}` : null;
}

/**
 * Batches routine events and flushes them on a fixed window.
 *
 * The window is deliberately *tumbling* — measured from the first buffered
 * event, not extended by later ones. A sliding window would let a long transfer
 * batch postpone its own digest indefinitely, which is precisely when you want
 * to hear something.
 */
export class Notifier {
  private buffer: NotifyEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Test seam: awaited by tests so they need not sleep for the real window. */
  private inFlight: Promise<void> = Promise.resolve();

  /** Accepts an event. Never throws and never blocks the caller. */
  push(event: NotifyEvent): void {
    if (!isEnabled()) return;
    if (!isNotifiable(event)) return;

    if (isImmediate(event)) {
      this.dispatch([event]);
      return;
    }

    this.buffer.push(event);
    if (this.timer) return;

    const windowMs = Math.max(1, getEnv().notifyDigestSeconds) * 1000;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, windowMs);
    // A pending digest must not hold the process open at shutdown; anything
    // buffered is still in the activity log either way.
    this.timer.unref?.();
  }

  /** Sends whatever is buffered right now. */
  flush(): void {
    const events = this.buffer;
    this.buffer = [];
    if (events.length === 0) return;
    this.dispatch(events);
  }

  private dispatch(events: NotifyEvent[]): void {
    const notification = renderDigest(events);
    if (!notification) return;
    this.inFlight = this.inFlight.then(() => deliver(notification));
  }

  /** Test seam: resolves once every dispatched send has settled. */
  async settled(): Promise<void> {
    await this.inFlight;
  }
}

/** True when at least one transport is configured. */
export function isEnabled(): boolean {
  try {
    const env = getEnv();
    return Boolean(mattermostMode() || (env.vapidPublicKey && env.vapidPrivateKey));
  } catch {
    // A broken configuration is already surfaced loudly elsewhere; it must not
    // turn every log line into a second failure.
    return false;
  }
}

/**
 * Fans a notification out to every configured transport.
 *
 * Transports are independent: Mattermost being down must not cost you the push
 * to your phone, so failures are contained per transport and never propagate to
 * the caller, which is usually the background worker mid-transfer.
 */
export async function deliver(notification: Notification): Promise<void> {
  const env = getEnv();
  const attempts: Array<Promise<unknown>> = [];

  if (mattermostMode()) attempts.push(sendMattermost(notification));
  if (env.vapidPublicKey && env.vapidPrivateKey) attempts.push(sendWebPush(notification));

  const results = await Promise.allSettled(attempts);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[abs-sync] notification transport failed:', describe(result.reason));
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const globalForNotifier = globalThis as unknown as { absSyncNotifier?: Notifier };

export function getNotifier(): Notifier {
  globalForNotifier.absSyncNotifier ??= new Notifier();
  return globalForNotifier.absSyncNotifier;
}
