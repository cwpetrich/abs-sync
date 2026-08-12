import path from 'node:path';
import { decryptJson, encryptJson } from './crypto';

/**
 * NOTE: `./db` is imported lazily inside the async functions below, never at
 * module scope. `env.ts` imports this module, `db.ts` calls `getEnv()` while it
 * is evaluating, and a static import here closes that loop — the second import
 * of `env.ts` finds its module-level cache still in the temporal dead zone and
 * throws `Cannot access 'cached' before initialization`, with the failure
 * depending on which file the process happened to import first. Reading
 * settings needs no database at all; only loading and saving do, and both are
 * already async.
 */

/**
 * Live configuration.
 *
 * Configuration used to be environment-only, which made a container
 * reproducible but meant every adjustment — a watch interval, a Mattermost
 * token, a concurrency limit — cost an edit and a restart, and a restart during
 * a transfer is not free. Settings now resolve in three tiers:
 *
 *   database override  →  environment variable  →  built-in default
 *
 * The database wins so the UI is authoritative once you touch a setting. The
 * environment is still read, so an existing `.env` keeps working untouched and
 * a fresh container still comes up configured before anyone opens the UI. The
 * UI names which tier each value came from, because "I set that and nothing
 * happened" is the failure mode this design would otherwise invite.
 *
 * Two settings deliberately cannot move here:
 *
 *  - **ABS_SYNC_SECRET** is the key that encrypts credentials *in this
 *    database*, including the secret-valued settings below. Storing it beside
 *    its own ciphertext would make the encryption ornamental.
 *  - **DATABASE_URL** is how the settings are found in the first place.
 *
 * A third, ABS_SYNC_ALLOWED_ORIGINS, is read by `next.config.ts` while the
 * server boots, long before a database connection exists. It stays in the
 * environment rather than being offered as a live setting that silently would
 * not apply until restart.
 */

export type SettingKind = 'number' | 'text' | 'boolean' | 'url' | 'secret';
export type SettingGroup = 'transfers' | 'indexing' | 'notifications' | 'security';

export interface SettingDefinition {
  envVar: string;
  kind: SettingKind;
  group: SettingGroup;
  label: string;
  hint: string;
  /**
   * Built-in default in its string form, computed lazily: the spool directory
   * is relative to the working directory, which is not known at module load.
   */
  fallback: () => string | null;
  /** Rejects values below this, for numbers. */
  min?: number;
  /** Whether a change only takes effect on the next transfer rather than now. */
  deferred?: boolean;
}

/**
 * Every live-editable setting.
 *
 * This is the single source of truth: the environment reader, the validator,
 * and the Settings form are all driven from here, so adding a setting is one
 * entry rather than four edits that can drift apart.
 */
export const SETTINGS = {
  spoolDir: {
    envVar: 'ABS_SYNC_SPOOL_DIR',
    kind: 'text',
    group: 'transfers',
    label: 'Spool directory',
    hint: 'Where downloads land before upload, and are kept for retries. Needs room for your largest item. Avoid /tmp, which reboots clear.',
    fallback: () => path.resolve(process.cwd(), 'spool'),
    deferred: true,
  },
  maxConcurrentSyncs: {
    envVar: 'ABS_SYNC_MAX_CONCURRENT',
    kind: 'number',
    group: 'transfers',
    label: 'Concurrent transfers',
    hint: 'How many books transfer at once. Raising this shares one connection between more downloads rather than making any of them faster.',
    fallback: () => '2',
    min: 1,
  },
  maxItemSizeBytes: {
    envVar: 'ABS_SYNC_MAX_ITEM_BYTES',
    kind: 'number',
    group: 'transfers',
    label: 'Per-item size limit (bytes)',
    hint: 'Refuse any single item larger than this, as a guard against runaway disk use.',
    fallback: () => String(25 * 1024 * 1024 * 1024),
    min: 1,
  },
  spoolKeepBytes: {
    envVar: 'ABS_SYNC_SPOOL_KEEP_BYTES',
    kind: 'number',
    group: 'transfers',
    label: 'Retained downloads (bytes)',
    hint: 'Downloaded audio kept for transfers that have not succeeded, so a retry need not re-fetch it. 0 keeps nothing.',
    fallback: () => String(20 * 1024 * 1024 * 1024),
    min: 0,
  },
  watchIntervalMinutes: {
    envVar: 'ABS_SYNC_WATCH_INTERVAL_MINUTES',
    kind: 'number',
    group: 'indexing',
    label: 'Watch interval (minutes)',
    hint: 'How often every server is re-indexed and watched series are re-checked.',
    fallback: () => '60',
    min: 1,
  },
  fullReindexHours: {
    envVar: 'ABS_SYNC_FULL_REINDEX_HOURS',
    kind: 'number',
    group: 'indexing',
    label: 'Full re-index after (hours)',
    hint: 'Incremental runs cannot see deletions, so this bounds how stale a removal can be.',
    fallback: () => '24',
    min: 1,
  },
  requireHttps: {
    envVar: 'ABS_SYNC_REQUIRE_HTTPS',
    kind: 'boolean',
    group: 'security',
    label: 'Require HTTPS for servers',
    hint: 'Reject plain-http server URLs when adding a server, except localhost.',
    fallback: () => 'false',
  },
  mattermostUrl: {
    envVar: 'ABS_SYNC_MATTERMOST_URL',
    kind: 'url',
    group: 'notifications',
    label: 'Mattermost server URL',
    hint: 'Base URL, e.g. https://mattermost.example.com. With a token and channel set, this is used in preference to a webhook.',
    fallback: () => null,
  },
  mattermostToken: {
    envVar: 'ABS_SYNC_MATTERMOST_TOKEN',
    kind: 'secret',
    group: 'notifications',
    label: 'Mattermost token',
    hint: 'Bot or personal access token. The account it belongs to must be a member of the channel.',
    fallback: () => null,
  },
  mattermostTeam: {
    envVar: 'ABS_SYNC_MATTERMOST_TEAM',
    kind: 'text',
    group: 'notifications',
    label: 'Mattermost team',
    hint: 'The <team> in https://your-server/<team>/channels/<channel>.',
    fallback: () => null,
  },
  mattermostChannel: {
    envVar: 'ABS_SYNC_MATTERMOST_CHANNEL',
    kind: 'text',
    group: 'notifications',
    label: 'Mattermost channel',
    hint: 'Channel name, not display name. Required for the API; optional for a webhook, where it overrides the default channel.',
    fallback: () => null,
  },
  mattermostWebhookUrl: {
    envVar: 'ABS_SYNC_MATTERMOST_WEBHOOK_URL',
    kind: 'secret',
    group: 'notifications',
    label: 'Mattermost webhook URL',
    hint: 'Used when no token is set. Treated as a credential: anyone holding it can post to the channel.',
    fallback: () => null,
  },
  vapidPublicKey: {
    envVar: 'ABS_SYNC_VAPID_PUBLIC_KEY',
    kind: 'text',
    group: 'notifications',
    label: 'VAPID public key',
    hint: 'Browser push identity. Generate a pair with: npm run notify:keys',
    fallback: () => null,
  },
  vapidPrivateKey: {
    envVar: 'ABS_SYNC_VAPID_PRIVATE_KEY',
    kind: 'secret',
    group: 'notifications',
    label: 'VAPID private key',
    hint: 'Changing this unsubscribes every device that had notifications enabled.',
    fallback: () => null,
  },
  vapidSubject: {
    envVar: 'ABS_SYNC_VAPID_SUBJECT',
    kind: 'text',
    group: 'notifications',
    label: 'VAPID subject',
    hint: 'How the push services reach you about a misbehaving server.',
    fallback: () => 'mailto:abs-sync@localhost',
  },
  publicUrl: {
    envVar: 'ABS_SYNC_PUBLIC_URL',
    kind: 'url',
    group: 'notifications',
    label: 'Public URL',
    hint: 'Absolute URL this app is reached at, used for links inside notifications. Links are omitted entirely when unset.',
    fallback: () => null,
  },
  notifyDigestSeconds: {
    envVar: 'ABS_SYNC_NOTIFY_DIGEST_SECONDS',
    kind: 'number',
    group: 'notifications',
    label: 'Digest window (seconds)',
    hint: 'Routine notifications are batched over this window. Failures ignore it and send immediately.',
    fallback: () => '30',
    min: 1,
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

// ------------------------------------------------------------------ validation

/**
 * Checks a value in its string form, returning an error message or null.
 *
 * Validation happens on write rather than on read. A bad environment variable
 * has always thrown at startup, which is fine because the operator is right
 * there; a bad value saved from the UI must be refused at the form instead of
 * breaking a running transfer worker minutes later.
 */
export function validate(key: SettingKey, raw: string): string | null {
  const definition: SettingDefinition = SETTINGS[key];
  const value = raw.trim();
  if (value === '') return null; // Empty means "unset"; the tier below applies.

  switch (definition.kind) {
    case 'number': {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return `${definition.label} must be a number`;
      const min = definition.min ?? 1;
      if (parsed < min) return `${definition.label} must be at least ${min}`;
      return null;
    }
    case 'url': {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return `${definition.label} must be an absolute URL`;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `${definition.label} must be http or https`;
      }
      return null;
    }
    case 'boolean':
      return value === 'true' || value === 'false' ? null : `${definition.label} must be true or false`;
    case 'secret':
    case 'text':
      return null;
  }
}

// -------------------------------------------------------------------- storage

/** AppSetting keys are namespaced so the table stays usable for other state. */
const PREFIX = 'config.';

/**
 * Resolved database overrides, held in memory.
 *
 * `getEnv()` is synchronous and called 28 times across the app, including once
 * per worker tick — making it async to await a query would be a rewrite of
 * every call site to pay a database round trip on a hot path. So overrides are
 * loaded once at boot and refreshed whenever they are written, and reads stay
 * free. This is safe because abs-sync is a single process; a second instance
 * against the same database would not see the first's changes until its own
 * reload.
 */
let overrides = new Map<SettingKey, string>();
let loaded = false;

export function isLoaded(): boolean {
  return loaded;
}

/** Reads every stored override into memory. Call before serving traffic. */
export async function loadSettings(): Promise<void> {
  const { prisma } = await import('./db');
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: PREFIX } } });
  const next = new Map<SettingKey, string>();

  for (const row of rows) {
    const key = row.key.slice(PREFIX.length) as SettingKey;
    if (!(key in SETTINGS)) continue; // A setting removed in a later version.
    const definition: SettingDefinition = SETTINGS[key];

    if (definition.kind === 'secret') {
      try {
        next.set(key, decryptJson<string>(row.value));
      } catch {
        // A rotated ABS_SYNC_SECRET makes stored secrets unreadable. Skipping
        // the value falls back to the environment rather than taking the whole
        // app down over one unreadable token.
        console.error(
          `[abs-sync] could not decrypt setting "${key}" — it was saved under a different ABS_SYNC_SECRET. Re-enter it in Settings.`,
        );
      }
      continue;
    }
    next.set(key, row.value);
  }

  overrides = next;
  loaded = true;
  invalidate?.();
}

/**
 * Hook the env module registers so its cache is dropped when settings change.
 * Kept as a callback to avoid importing env.ts here, which imports this.
 */
let invalidate: (() => void) | null = null;
export function onSettingsChanged(callback: () => void): void {
  invalidate = callback;
}

/** The stored override for a key, or null when none is set. */
export function overrideFor(key: SettingKey): string | null {
  return overrides.get(key) ?? null;
}

export type SettingSource = 'database' | 'environment' | 'default';

/** Where a key's effective value comes from, and what it is. */
export function resolve(key: SettingKey): { value: string | null; source: SettingSource } {
  const stored = overrides.get(key);
  if (stored !== undefined && stored !== '') return { value: stored, source: 'database' };

  const definition: SettingDefinition = SETTINGS[key];
  const fromEnv = process.env[definition.envVar]?.trim();
  if (fromEnv) return { value: fromEnv, source: 'environment' };

  return { value: definition.fallback(), source: 'default' };
}

/**
 * Writes overrides.
 *
 * An empty string deletes the override, which is how "reset to the environment
 * or the default" is expressed — distinct from storing an empty value, which
 * would be indistinguishable from unset on the way back out.
 */
export async function setSettings(patch: Partial<Record<SettingKey, string>>): Promise<void> {
  const errors: string[] = [];
  for (const [key, raw] of Object.entries(patch) as Array<[SettingKey, string]>) {
    if (!(key in SETTINGS)) {
      errors.push(`Unknown setting "${key}"`);
      continue;
    }
    const problem = validate(key, raw);
    if (problem) errors.push(problem);
  }
  if (errors.length > 0) throw new Error(errors.join('; '));

  const { prisma } = await import('./db');
  for (const [key, raw] of Object.entries(patch) as Array<[SettingKey, string]>) {
    const value = raw.trim();
    const dbKey = `${PREFIX}${key}`;

    if (value === '') {
      await prisma.appSetting.deleteMany({ where: { key: dbKey } });
      continue;
    }

    const definition: SettingDefinition = SETTINGS[key];
    const stored = definition.kind === 'secret' ? encryptJson(value) : value;
    await prisma.appSetting.upsert({
      where: { key: dbKey },
      create: { key: dbKey, value: stored },
      update: { value: stored },
    });
  }

  await loadSettings();
}

/** Test seam: forgets loaded overrides without touching the database. */
export function resetSettingsCache(): void {
  overrides = new Map();
  loaded = false;
  invalidate?.();
}
