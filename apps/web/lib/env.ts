import {
  onSettingsChanged,
  resolve,
  SETTINGS,
  type SettingDefinition,
  type SettingKey,
} from './settings';

/**
 * Server-only configuration. Reading these on the client would leak the
 * credential secret, so this module must never be imported from a component
 * that runs in the browser.
 *
 * Only two values are read straight from the environment. Everything else
 * resolves through `lib/settings.ts`, which layers a database override over the
 * environment variable over a built-in default — see that file for why those
 * two cannot join them.
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

const MIN_SECRET_LENGTH = 32;

let cached: AppEnv | null = null;

export interface AppEnv {
  databaseUrl: string;
  /** Master secret for credential encryption at rest. Environment-only. */
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

  /** Base URL of a Mattermost server, for posting through the REST API. */
  mattermostUrl: string | null;
  /** Bot or personal access token. A credential: it can post as its account. */
  mattermostToken: string | null;
  /** Team the channel lives in — the `<team>` in /<team>/channels/<channel>. */
  mattermostTeam: string | null;
  /** Incoming-webhook URL, used when no API token is configured. */
  mattermostWebhookUrl: string | null;
  /** Channel name to post into. Required for the API, optional for a webhook. */
  mattermostChannel: string | null;
  /** VAPID keypair identifying this server to the browser push services. */
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  /** Contact address the push services use to reach the operator. */
  vapidSubject: string;
  /** Absolute base URL used to build links inside notifications. */
  publicUrl: string | null;
  /** Window over which routine notifications are batched into one message. */
  notifyDigestSeconds: number;
}

/** The effective string value for a setting, from whichever tier supplies it. */
function raw(key: SettingKey): string | null {
  return resolve(key).value;
}

/**
 * A number from the resolved tiers.
 *
 * A malformed value falls back rather than throwing. The form validates on
 * write, so the only way to reach this is an environment variable typed by
 * hand — and taking down a running transfer worker over one bad number is a
 * worse outcome than carrying on with the default and saying so.
 */
function number(key: SettingKey): number {
  const definition: SettingDefinition = SETTINGS[key];
  const value = raw(key);
  if (value === null) return Number(definition.fallback() ?? 0);
  const parsed = Number(value);
  const min = definition.min ?? 1;
  if (!Number.isFinite(parsed) || parsed < min) {
    console.error(
      `[abs-sync] ${definition.envVar} is "${value}", which is not a number >= ${min}. Using the default.`,
    );
    return Number(definition.fallback() ?? 0);
  }
  return parsed;
}

function text(key: SettingKey): string | null {
  return raw(key);
}

function boolean(key: SettingKey): boolean {
  return raw(key) === 'true';
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
    // Deliberately not os.tmpdir(): downloaded audio is retained across
    // restarts so a retry need not re-fetch it, and /tmp is cleared on reboot on
    // most Linux systems, which would silently throw that cache away.
    spoolDir: text('spoolDir')!,
    maxConcurrentSyncs: number('maxConcurrentSyncs'),
    watchIntervalMinutes: number('watchIntervalMinutes'),
    fullReindexHours: number('fullReindexHours'),
    maxItemSizeBytes: number('maxItemSizeBytes'),
    spoolKeepBytes: number('spoolKeepBytes'),
    requireHttps: boolean('requireHttps'),
    mattermostUrl: text('mattermostUrl')?.replace(/\/+$/, '') ?? null,
    mattermostToken: text('mattermostToken'),
    mattermostTeam: text('mattermostTeam'),
    mattermostWebhookUrl: text('mattermostWebhookUrl'),
    mattermostChannel: text('mattermostChannel'),
    vapidPublicKey: text('vapidPublicKey'),
    vapidPrivateKey: text('vapidPrivateKey'),
    vapidSubject: text('vapidSubject')!,
    publicUrl: text('publicUrl')?.replace(/\/+$/, '') ?? null,
    notifyDigestSeconds: number('notifyDigestSeconds'),
  };
  return cached;
}

/** Forces the next getEnv() to re-read the environment and stored settings. */
export function resetEnvCache(): void {
  cached = null;
}

// Saving a setting has to be visible to the worker mid-run, not at next boot.
onSettingsChanged(resetEnvCache);
