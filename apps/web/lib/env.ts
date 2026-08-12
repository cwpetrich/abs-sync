import path from 'node:path';

/**
 * Server-only configuration. Reading these on the client would leak the
 * credential secret, so this module must never be imported from a component
 * that runs in the browser.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in before starting abs-sync.`,
    );
  }
  return value.trim();
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return parsed;
}

/**
 * An absolute http(s) URL, or null when unset.
 *
 * Validated at load rather than at send time: a typo'd webhook is otherwise
 * invisible until the moment something goes wrong and the alert about it also
 * fails to arrive.
 */
function optionalUrl(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL, got "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must be http or https, got "${parsed.protocol}"`);
  }
  return raw;
}

const MIN_SECRET_LENGTH = 32;

let cached: AppEnv | null = null;

export interface AppEnv {
  databaseUrl: string;
  /** Master secret for credential encryption at rest. */
  secret: string;
  /** Where in-flight downloads are spooled before upload. */
  spoolDir: string;
  /** Simultaneous book transfers. */
  maxConcurrentSyncs: number;
  /** How often the watch scheduler re-checks sources, in minutes. */
  watchIntervalMinutes: number;
  /**
   * Maximum age of a full index reconcile before one is forced. Incremental runs
   * cannot see deletions, so this bounds how stale a removal can be.
   */
  fullReindexHours: number;
  /** Refuse transfers larger than this, as a guard against runaway disk use. */
  maxItemSizeBytes: number;
  /**
   * How many bytes of already-downloaded audio to keep on disk for transfers that
   * have not succeeded yet, so a retry does not re-download what it already has.
   * Oldest retained spools are evicted first once this is exceeded. Set to 0 to
   * disable retention entirely.
   */
  spoolKeepBytes: number;
  /** Reject non-HTTPS server URLs (except localhost) when true. */
  requireHttps: boolean;

  /**
   * Base URL of a Mattermost server, for posting through the REST API with a
   * bot or personal access token. Preferred over the webhook when set, because
   * it is configured by channel name and one token can serve several channels.
   */
  mattermostUrl: string | null;
  /** Bot or personal access token. A credential: it can post as its account. */
  mattermostToken: string | null;
  /** Team the channel lives in — the `<team>` in /<team>/channels/<channel>. */
  mattermostTeam: string | null;
  /**
   * Incoming-webhook URL for a Mattermost channel. Used when no API token is
   * configured. Null disables the transport; notifications simply are not sent
   * rather than erroring.
   */
  mattermostWebhookUrl: string | null;
  /**
   * Channel *name* (not display name) to post into. Required for the API
   * transport; optional for the webhook, where it overrides the channel the
   * webhook was created against.
   */
  mattermostChannel: string | null;
  /**
   * VAPID keypair identifying this server to the browser push services. Both
   * halves must be present for browser notifications to work at all; generate
   * them with `npm run notify:keys`.
   */
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  /** Contact address the push services use to reach the operator. */
  vapidSubject: string;
  /**
   * Absolute base URL this app is reached at, used to build links inside
   * notifications. A notification arriving on a phone is useless if tapping it
   * opens a hostname only the server can resolve.
   */
  publicUrl: string | null;
  /**
   * Window over which routine notifications are batched into one message. A
   * single watch pass can queue a dozen books; sending one push per book turns
   * a useful signal into something you mute.
   */
  notifyDigestSeconds: number;
}

export function getEnv(): AppEnv {
  if (cached) return cached;

  const secret = requireEnv('ABS_SYNC_SECRET');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `ABS_SYNC_SECRET must be at least ${MIN_SECRET_LENGTH} characters. ` +
        'Generate one with: openssl rand -base64 48',
    );
  }

  cached = {
    databaseUrl: requireEnv('DATABASE_URL'),
    secret,
    // Deliberately not os.tmpdir(): downloaded audio is now retained across
    // restarts so a retry need not re-fetch it, and /tmp is cleared on reboot on
    // most Linux systems (`D /tmp ... 30d` in tmpfiles.d), which would silently
    // throw that cache away. `spool/` is already gitignored.
    spoolDir: process.env.ABS_SYNC_SPOOL_DIR?.trim() || path.resolve(process.cwd(), 'spool'),
    maxConcurrentSyncs: optionalNumber('ABS_SYNC_MAX_CONCURRENT', 2),
    watchIntervalMinutes: optionalNumber('ABS_SYNC_WATCH_INTERVAL_MINUTES', 60),
    fullReindexHours: optionalNumber('ABS_SYNC_FULL_REINDEX_HOURS', 24),
    maxItemSizeBytes: optionalNumber('ABS_SYNC_MAX_ITEM_BYTES', 25 * 1024 * 1024 * 1024),
    spoolKeepBytes: optionalNumber('ABS_SYNC_SPOOL_KEEP_BYTES', 20 * 1024 * 1024 * 1024),
    requireHttps: process.env.ABS_SYNC_REQUIRE_HTTPS === 'true',
    mattermostUrl: optionalUrl('ABS_SYNC_MATTERMOST_URL')?.replace(/\/+$/, '') ?? null,
    mattermostToken: process.env.ABS_SYNC_MATTERMOST_TOKEN?.trim() || null,
    mattermostTeam: process.env.ABS_SYNC_MATTERMOST_TEAM?.trim() || null,
    mattermostWebhookUrl: optionalUrl('ABS_SYNC_MATTERMOST_WEBHOOK_URL'),
    mattermostChannel: process.env.ABS_SYNC_MATTERMOST_CHANNEL?.trim() || null,
    vapidPublicKey: process.env.ABS_SYNC_VAPID_PUBLIC_KEY?.trim() || null,
    vapidPrivateKey: process.env.ABS_SYNC_VAPID_PRIVATE_KEY?.trim() || null,
    vapidSubject: process.env.ABS_SYNC_VAPID_SUBJECT?.trim() || 'mailto:abs-sync@localhost',
    publicUrl: optionalUrl('ABS_SYNC_PUBLIC_URL')?.replace(/\/+$/, '') ?? null,
    notifyDigestSeconds: optionalNumber('ABS_SYNC_NOTIFY_DIGEST_SECONDS', 30),
  };
  return cached;
}

/** Test hook: forces the next getEnv() to re-read process.env. */
export function resetEnvCache(): void {
  cached = null;
}
