import { getEnv } from './env';
import type { Notification } from './notify';

/**
 * Mattermost delivery, by either of the two ways Mattermost accepts a message.
 *
 *  - **Bot/user token against the REST API.** Configured by channel *name*, so
 *    one token can serve several channels, and it works on servers where
 *    incoming webhooks are disabled org-wide.
 *  - **Incoming webhook.** No token to manage and least privilege: a leaked
 *    webhook URL can only post to its own channel, where a leaked token can
 *    read and post wherever its account can reach.
 *
 * The API is preferred when configured. Only the transport differs — both send
 * the same rendered text.
 */

/** Matches the level to something scannable in a channel full of text. */
const ICON: Record<Notification['level'], string> = {
  info: ':inbox_tray:',
  warn: ':warning:',
  error: ':rotating_light:',
};

/**
 * A hung server must not wedge a transfer. Mattermost is frequently self-hosted
 * on the same LAN as everything else here — when it is down it tends to be
 * *unreachable* rather than refusing, which is the slow failure mode.
 */
const TIMEOUT_MS = 10_000;

function render(notification: Notification): string {
  const heading = notification.url
    ? `[**${notification.title}**](${notification.url})`
    : `**${notification.title}**`;
  return `${ICON[notification.level]} ${heading}\n${notification.body}`;
}

/** Which transport the current configuration selects, if any. */
export function mattermostMode(): 'api' | 'webhook' | null {
  const env = getEnv();
  if (env.mattermostUrl && env.mattermostToken && env.mattermostChannel) return 'api';
  if (env.mattermostWebhookUrl) return 'webhook';
  return null;
}

export async function sendMattermost(notification: Notification): Promise<void> {
  const mode = mattermostMode();
  if (mode === 'api') await sendViaApi(notification);
  else if (mode === 'webhook') await sendViaWebhook(notification);
}

// ------------------------------------------------------------------- webhook

async function sendViaWebhook(notification: Notification): Promise<void> {
  const { mattermostWebhookUrl, mattermostChannel } = getEnv();
  if (!mattermostWebhookUrl) return;

  const response = await fetch(mattermostWebhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'abs-sync',
      icon_emoji: ':headphones:',
      ...(mattermostChannel ? { channel: mattermostChannel } : {}),
      text: render(notification),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    // Mattermost explains refusals in the body (bad channel, disabled webhook,
    // revoked token); without it the operator only learns "it did not work".
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Mattermost webhook returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
}

// ----------------------------------------------------------------------- API

/**
 * Resolved channel id, cached for the process.
 *
 * Posting takes an id, but an id is not something a human can be asked to
 * configure — it does not appear anywhere in the Mattermost UI. So the config
 * is a team and channel *name* and this resolves it once, rather than spending
 * a lookup on every notification.
 */
let channelIdCache: { key: string; id: string } | null = null;

async function mattermostFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { mattermostUrl, mattermostToken } = getEnv();
  return fetch(`${mattermostUrl}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${mattermostToken}`,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Turns "town-square" into the id the posts endpoint wants. */
async function resolveChannelId(): Promise<string> {
  const { mattermostTeam, mattermostChannel } = getEnv();
  const key = `${mattermostTeam}/${mattermostChannel}`;
  if (channelIdCache?.key === key) return channelIdCache.id;

  if (!mattermostTeam) {
    throw new Error(
      'ABS_SYNC_MATTERMOST_TEAM is required to post by channel name. It is the team ' +
        'segment of the channel URL: https://your-server/<team>/channels/<channel>.',
    );
  }

  const response = await mattermostFetch(
    `/api/v4/teams/name/${encodeURIComponent(mattermostTeam)}/channels/name/${encodeURIComponent(
      mattermostChannel!,
    )}`,
  );

  if (response.status === 401) {
    throw new Error('Mattermost rejected the token (ABS_SYNC_MATTERMOST_TOKEN invalid or expired)');
  }
  if (response.status === 403 || response.status === 404) {
    // 404 here is ambiguous on purpose in Mattermost: it is returned both for a
    // channel that does not exist and for one the account cannot see, so the
    // message has to name both possibilities rather than guess.
    throw new Error(
      `Mattermost could not find channel "${mattermostChannel}" in team "${mattermostTeam}". ` +
        'Check both names, and that the bot or user the token belongs to is a member of that channel.',
    );
  }
  if (!response.ok) {
    throw new Error(`Mattermost channel lookup returned ${response.status}`);
  }

  const channel = (await response.json()) as { id?: string };
  if (!channel.id) throw new Error('Mattermost channel lookup returned no id');

  channelIdCache = { key, id: channel.id };
  return channel.id;
}

async function sendViaApi(notification: Notification): Promise<void> {
  const channelId = await resolveChannelId();

  const response = await mattermostFetch('/api/v4/posts', {
    method: 'POST',
    body: JSON.stringify({ channel_id: channelId, message: render(notification) }),
  });

  if (response.status === 401) {
    throw new Error('Mattermost rejected the token (ABS_SYNC_MATTERMOST_TOKEN invalid or expired)');
  }
  if (response.status === 403) {
    throw new Error(
      `Mattermost refused the post to "${getEnv().mattermostChannel}". The account the token ` +
        'belongs to must be a member of that channel — adding a bot to a team does not add it to channels.',
    );
  }
  if (response.status === 404) {
    // The channel was archived or deleted since it was resolved; drop the cache
    // so a fix does not require restarting the app.
    channelIdCache = null;
    throw new Error(`Mattermost no longer has the channel this was posting to (it was ${channelId})`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Mattermost post returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
}

/** Test seam: forgets the resolved channel id. */
export function resetChannelCache(): void {
  channelIdCache = null;
}
