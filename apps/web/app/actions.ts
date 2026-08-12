'use server';

import { revalidatePath } from 'next/cache';
import { describeError } from '../lib/activity';
import { prisma } from '../lib/db';
import { getEnv } from '../lib/env';
import { getIndexManager } from '../lib/index-manager';
import { deliver, isEnabled as isNotifyEnabled } from '../lib/notify';
import { getScheduler } from '../lib/scheduler';
import {
  createServer,
  deleteServer,
  setLibraryIncluded,
  setTargetServer,
  testConnection,
  updateServer,
  verifyAndRefresh,
  type ConnectionTestResult,
  type ServerCredentials,
} from '../lib/servers';
import {
  cancelJob,
  clearFinishedJobs,
  enqueueSync,
  retryJob,
  type EnqueueOutcome,
} from '../lib/sync-worker';
import { createWatch, deleteWatch, evaluateWatch, setWatchEnabled } from '../lib/watches';

/**
 * Server Actions.
 *
 * Note on security: this app has no user accounts — it is a single-tenant,
 * self-hosted admin tool, and anyone who can reach it can already read every
 * credential-derived capability. Deploy it behind your own authentication (a
 * reverse proxy with auth, a VPN, or a LAN-only bind). These actions are
 * reachable by direct POST, so do not expose the app to the internet unguarded.
 */

/** Success with no payload. */
export type ActionResult = { ok: true } | { ok: false; error: string };
/** Success carrying a payload. Kept separate from ActionResult so the success
 * branch does not distribute over unions in `T`. */
export type ActionResultWith<T> = { ok: true; data: T } | { ok: false; error: string };

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: describeError(error) };
}

function credentialsFromForm(formData: FormData): ServerCredentials {
  const authKind = String(formData.get('authKind') ?? 'apiKey');
  if (authKind === 'password') {
    return {
      kind: 'password',
      username: String(formData.get('username') ?? ''),
      password: String(formData.get('password') ?? ''),
    };
  }
  return { kind: 'apiKey', apiKey: String(formData.get('apiKey') ?? '') };
}

// ------------------------------------------------------------------- servers

export async function testConnectionAction(
  formData: FormData,
): Promise<ActionResultWith<ConnectionTestResult>> {
  try {
    const result = await testConnection(
      String(formData.get('baseUrl') ?? ''),
      credentialsFromForm(formData),
      { asTarget: formData.get('isTarget') === 'on' },
    );
    return { ok: true, data: result };
  } catch (error) {
    return fail(error);
  }
}

export async function addServerAction(formData: FormData): Promise<ActionResult> {
  try {
    await createServer({
      name: String(formData.get('name') ?? ''),
      baseUrl: String(formData.get('baseUrl') ?? ''),
      credentials: credentialsFromForm(formData),
      isTarget: formData.get('isTarget') === 'on',
    });
    revalidatePath('/servers');
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function updateServerCredentialsAction(formData: FormData): Promise<ActionResult> {
  try {
    await updateServer(String(formData.get('serverId') ?? ''), {
      credentials: credentialsFromForm(formData),
    });
    revalidatePath('/servers');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteServerAction(serverId: string): Promise<ActionResult> {
  try {
    await deleteServer(serverId);
    revalidatePath('/servers');
    revalidatePath('/');
    revalidatePath('/compare');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function setTargetServerAction(serverId: string): Promise<ActionResult> {
  try {
    await setTargetServer(serverId);
    revalidatePath('/servers');
    revalidatePath('/compare');
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function verifyServerAction(serverId: string): Promise<ActionResult> {
  try {
    await verifyAndRefresh(serverId);
    revalidatePath('/servers');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function setServerEnabledAction(
  serverId: string,
  enabled: boolean,
): Promise<ActionResult> {
  try {
    await updateServer(serverId, { enabled });
    revalidatePath('/servers');
    revalidatePath('/compare');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function setLibraryIncludedAction(
  libraryId: string,
  included: boolean,
): Promise<ActionResult> {
  try {
    await setLibraryIncluded(libraryId, included);
    revalidatePath('/servers');
    revalidatePath('/compare');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// ------------------------------------------------------------------ indexing

export async function startIndexAction(
  serverId: string,
  mode: 'auto' | 'full' = 'auto',
): Promise<ActionResult> {
  try {
    const result = getIndexManager().start(serverId, mode);
    if (!result.started) return { ok: false, error: result.reason ?? 'Could not start indexing' };
    revalidatePath('/servers');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function cancelIndexAction(serverId: string): Promise<ActionResult> {
  getIndexManager().cancel(serverId);
  revalidatePath('/servers');
  return { ok: true };
}

export async function startIndexAllAction(
  serverIds: string[],
  mode: 'auto' | 'full' = 'auto',
): Promise<ActionResult> {
  try {
    const manager = getIndexManager();
    for (const serverId of serverIds) manager.start(serverId, mode);
    revalidatePath('/servers');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// -------------------------------------------------------------------- syncing

export interface SyncRequestItem {
  serverId: string;
  itemId: string;
  libraryId: string;
  title: string;
  author?: string | null;
  series?: string | null;
}

export async function syncBookAction(item: SyncRequestItem): Promise<ActionResultWith<EnqueueOutcome>> {
  try {
    const outcome = await enqueueSync({
      sourceServerId: item.serverId,
      sourceItemId: item.itemId,
      sourceLibraryId: item.libraryId,
      title: item.title,
      author: item.author ?? null,
      series: item.series ?? null,
      origin: 'manual',
    });
    if (outcome.status === 'rejected') return { ok: false, error: outcome.reason };
    revalidatePath('/jobs');
    revalidatePath('/compare');
    return { ok: true, data: outcome };
  } catch (error) {
    return fail(error);
  }
}

export async function syncManyAction(
  items: SyncRequestItem[],
): Promise<ActionResultWith<{ queued: number; duplicates: number; failures: string[] }>> {
  const summary = { queued: 0, duplicates: 0, failures: [] as string[] };
  for (const item of items) {
    try {
      const outcome = await enqueueSync({
        sourceServerId: item.serverId,
        sourceItemId: item.itemId,
        sourceLibraryId: item.libraryId,
        title: item.title,
        author: item.author ?? null,
        series: item.series ?? null,
        origin: 'manual',
      });
      if (outcome.status === 'queued') summary.queued++;
      else if (outcome.status === 'duplicate') summary.duplicates++;
      else summary.failures.push(`${item.title}: ${outcome.reason}`);
    } catch (error) {
      summary.failures.push(`${item.title}: ${describeError(error)}`);
    }
  }
  revalidatePath('/jobs');
  revalidatePath('/compare');
  return { ok: true, data: summary };
}

export async function cancelJobAction(jobId: string): Promise<ActionResult> {
  try {
    await cancelJob(jobId);
    revalidatePath('/jobs');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function retryJobAction(jobId: string): Promise<ActionResult> {
  try {
    const done = await retryJob(jobId);
    if (!done) return { ok: false, error: 'Only failed or canceled transfers can be retried' };
    revalidatePath('/jobs');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function clearFinishedJobsAction(): Promise<
  ActionResultWith<{ count: number; freedBytes: number }>
> {
  try {
    // Clearing also discards downloads retained for retrying failed transfers,
    // so the caller is told how much disk that freed.
    const result = await clearFinishedJobs();
    revalidatePath('/jobs');
    return { ok: true, data: result };
  } catch (error) {
    return fail(error);
  }
}

// -------------------------------------------------------------------- watches

export async function addWatchAction(formData: FormData): Promise<ActionResult> {
  try {
    const rawSources = formData.getAll('sourceServerIds').map(String).filter(Boolean);
    await createWatch({
      seriesName: String(formData.get('seriesName') ?? ''),
      author: String(formData.get('author') ?? '') || null,
      targetLibraryId: String(formData.get('targetLibraryId') ?? '') || undefined,
      sourceServerIds: rawSources.length > 0 ? rawSources : undefined,
      autoEnqueue: formData.get('autoEnqueue') !== 'off',
    });
    revalidatePath('/watches');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function quickWatchAction(
  seriesName: string,
  author?: string | null,
): Promise<ActionResult> {
  try {
    await createWatch({ seriesName, author: author ?? null });
    revalidatePath('/watches');
    revalidatePath('/compare');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteWatchAction(watchId: string): Promise<ActionResult> {
  try {
    await deleteWatch(watchId);
    revalidatePath('/watches');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function setWatchEnabledAction(
  watchId: string,
  enabled: boolean,
): Promise<ActionResult> {
  try {
    await setWatchEnabled(watchId, enabled);
    revalidatePath('/watches');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function checkWatchNowAction(
  watchId: string,
): Promise<ActionResultWith<{ enqueued: number; missing: number; candidates: number }>> {
  try {
    const evaluation = await evaluateWatch(watchId);
    revalidatePath('/watches');
    revalidatePath('/jobs');
    if (evaluation.error) return { ok: false, error: evaluation.error };
    return {
      ok: true,
      data: {
        enqueued: evaluation.enqueued,
        missing: evaluation.missing,
        candidates: evaluation.candidates,
      },
    };
  } catch (error) {
    return fail(error);
  }
}

// -------------------------------------------------------------- notifications

/**
 * Records a browser's push subscription.
 *
 * Keyed on the endpoint so re-subscribing the same device replaces its row
 * rather than accumulating one per visit — browsers hand out a fresh
 * subscription object freely, and without this a phone would collect a row
 * every time it cleared its cache and end up notified several times over.
 */
export async function subscribePushAction(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  label?: string,
): Promise<ActionResult> {
  try {
    const { endpoint, keys } = subscription;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return { ok: false, error: 'Incomplete push subscription from the browser' };
    }
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, label: label?.slice(0, 120) ?? null },
      update: { p256dh: keys.p256dh, auth: keys.auth, label: label?.slice(0, 120) ?? null },
    });
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function unsubscribePushAction(endpoint: string): Promise<ActionResult> {
  try {
    await prisma.pushSubscription.deleteMany({ where: { endpoint } });
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Sends a test notification through every configured transport.
 *
 * Delivered directly rather than through the digest buffer: pressing "Send
 * test" and waiting up to a full digest window for it would read as broken.
 * Errors are surfaced instead of swallowed — for this one call the whole point
 * is learning that a transport does not work.
 */
export async function sendTestNotificationAction(): Promise<ActionResult> {
  try {
    if (!isNotifyEnabled()) {
      return {
        ok: false,
        error:
          'No notification transport is configured. Set ABS_SYNC_MATTERMOST_WEBHOOK_URL, or the VAPID keys for browser push, and restart.',
      };
    }
    await deliver({
      title: 'abs-sync test',
      body: 'Notifications are working. This is what a real alert will look like.',
      level: 'info',
      url: getEnv().publicUrl,
    });
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function runSchedulerNowAction(): Promise<
  ActionResultWith<{ itemsIndexed: number; booksQueued: number; errors: string[] }>
> {
  try {
    const result = await getScheduler().runNow();
    revalidatePath('/');
    revalidatePath('/watches');
    revalidatePath('/jobs');
    return {
      ok: true,
      data: {
        itemsIndexed: result.itemsIndexed,
        booksQueued: result.booksQueued,
        errors: result.errors,
      },
    };
  } catch (error) {
    return fail(error);
  }
}
