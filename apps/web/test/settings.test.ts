import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/db';
import { getEnv, resetEnvCache } from '../lib/env';
import {
  loadSettings,
  resetSettingsCache,
  resolve,
  setSettings,
  validate,
} from '../lib/settings';

/**
 * Live configuration.
 *
 * The behaviour worth pinning down is the resolution order and the fact that a
 * saved change is visible to code already running — the worker reads its limits
 * through the same synchronous `getEnv()` as everything else, so a stale cache
 * would mean settings that appear to save and do nothing.
 */

async function clearStoredSettings(): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'config.' } } });
  await loadSettings();
}

beforeEach(async () => {
  await clearStoredSettings();
  resetEnvCache();
});

afterEach(async () => {
  await clearStoredSettings();
  for (const key of ['ABS_SYNC_MAX_CONCURRENT', 'ABS_SYNC_PUBLIC_URL', 'ABS_SYNC_MATTERMOST_TOKEN']) {
    delete process.env[key];
  }
  // The suite's other files expect the values test/setup.ts installed.
  process.env.ABS_SYNC_MAX_CONCURRENT = '2';
  resetEnvCache();
});

describe('resolution order', () => {
  it('falls back to the built-in default when nothing is set', async () => {
    delete process.env.ABS_SYNC_MAX_CONCURRENT;
    resetEnvCache();
    expect(resolve('maxConcurrentSyncs')).toEqual({ value: '2', source: 'default' });
  });

  it('prefers an environment variable over the default', async () => {
    process.env.ABS_SYNC_MAX_CONCURRENT = '5';
    resetEnvCache();
    expect(resolve('maxConcurrentSyncs')).toEqual({ value: '5', source: 'environment' });
    expect(getEnv().maxConcurrentSyncs).toBe(5);
  });

  it('prefers a stored override over the environment', async () => {
    process.env.ABS_SYNC_MAX_CONCURRENT = '5';
    resetEnvCache();
    await setSettings({ maxConcurrentSyncs: '9' });

    expect(resolve('maxConcurrentSyncs')).toEqual({ value: '9', source: 'database' });
    // The whole point: no restart, and the worker reads this on its next tick.
    expect(getEnv().maxConcurrentSyncs).toBe(9);
  });

  it('clearing an override falls back to the environment, not to empty', async () => {
    process.env.ABS_SYNC_MAX_CONCURRENT = '5';
    resetEnvCache();
    await setSettings({ maxConcurrentSyncs: '9' });
    await setSettings({ maxConcurrentSyncs: '' });

    expect(resolve('maxConcurrentSyncs')).toEqual({ value: '5', source: 'environment' });
    expect(getEnv().maxConcurrentSyncs).toBe(5);
  });

  it('survives a reload, so a restart keeps the saved value', async () => {
    await setSettings({ watchIntervalMinutes: '15' });
    resetSettingsCache();
    resetEnvCache();
    // Nothing in memory now — exactly the state a fresh process starts in.
    expect(getEnv().watchIntervalMinutes).toBe(60);

    await loadSettings();
    resetEnvCache();
    expect(getEnv().watchIntervalMinutes).toBe(15);
  });
});

describe('validation', () => {
  it('refuses values that would break the worker', () => {
    expect(validate('maxConcurrentSyncs', 'lots')).toMatch(/must be a number/);
    expect(validate('maxConcurrentSyncs', '0')).toMatch(/at least 1/);
    expect(validate('publicUrl', 'not-a-url')).toMatch(/absolute URL/);
    expect(validate('publicUrl', 'ftp://example.com')).toMatch(/http or https/);
    expect(validate('requireHttps', 'yes')).toMatch(/true or false/);
  });

  it('accepts an empty value, which means "unset"', () => {
    expect(validate('maxConcurrentSyncs', '')).toBeNull();
    expect(validate('publicUrl', '')).toBeNull();
  });

  it('rejects the whole save rather than applying half of it', async () => {
    await expect(
      setSettings({ maxConcurrentSyncs: '4', watchIntervalMinutes: '-3' }),
    ).rejects.toThrow(/at least 1/);

    // The valid half must not have landed: a partially applied save leaves the
    // operator with no idea what the running config actually is.
    expect(resolve('maxConcurrentSyncs').source).not.toBe('database');
  });

  it('allows zero for retention, where zero is meaningful', () => {
    expect(validate('spoolKeepBytes', '0')).toBeNull();
  });
});

describe('sizes', () => {
  it('accepts a written size and stores it as bytes', async () => {
    await setSettings({ maxItemSizeBytes: '30 GB' });

    // Canonical on the way in, so nothing downstream has to know about units.
    expect(resolve('maxItemSizeBytes').value).toBe(String(30 * 1024 ** 3));
    expect(getEnv().maxItemSizeBytes).toBe(30 * 1024 ** 3);
  });

  it('treats spacing and case as the same value, not as different rows', async () => {
    await setSettings({ maxItemSizeBytes: '30GB' });
    const compact = resolve('maxItemSizeBytes').value;
    await setSettings({ maxItemSizeBytes: '30 gb' });
    expect(resolve('maxItemSizeBytes').value).toBe(compact);
  });

  it('still accepts a bare byte count, so existing configs keep working', async () => {
    await setSettings({ maxItemSizeBytes: '26843545600' });
    expect(getEnv().maxItemSizeBytes).toBe(26843545600);
  });

  it('reads a written size from the environment too', () => {
    process.env.ABS_SYNC_MAX_ITEM_BYTES = '2 TB';
    resetEnvCache();
    expect(getEnv().maxItemSizeBytes).toBe(2 * 1024 ** 4);
    delete process.env.ABS_SYNC_MAX_ITEM_BYTES;
    resetEnvCache();
  });

  it('explains itself when the size is not one', () => {
    expect(validate('maxItemSizeBytes', 'big')).toMatch(/25 GB.*500 MB.*1\.5 TB/);
  });
});

describe('secrets', () => {
  it('does not store a token in plaintext', async () => {
    await setSettings({ mattermostToken: 'super-secret-token-value' });

    const row = await prisma.appSetting.findUnique({ where: { key: 'config.mattermostToken' } });
    expect(row).not.toBeNull();
    expect(row!.value).not.toContain('super-secret-token-value');
    // Same envelope the server credentials use.
    expect(row!.value.startsWith('v1:')).toBe(true);
  });

  it('round-trips a secret back out for use', async () => {
    await setSettings({ mattermostToken: 'super-secret-token-value' });
    expect(getEnv().mattermostToken).toBe('super-secret-token-value');

    // And still works after a cold load, which is what a restart does.
    resetSettingsCache();
    await loadSettings();
    resetEnvCache();
    expect(getEnv().mattermostToken).toBe('super-secret-token-value');
  });
});

describe('module layering', () => {
  it('initialises when env.ts is the first module imported', async () => {
    // env.ts imports settings.ts, and db.ts calls getEnv() while it evaluates.
    // A static `import { prisma }` in settings.ts closes that loop and throws
    // "Cannot access 'cached' before initialization" — but only when the
    // process happens to reach env.ts first, so it hides from most test files.
    vi.resetModules();
    const { getEnv: freshGetEnv } = await import('../lib/env');
    expect(() => freshGetEnv()).not.toThrow();
  });
});

describe('robustness', () => {
  it('ignores a stored value for a setting this version no longer has', async () => {
    await prisma.appSetting.create({ data: { key: 'config.removedInV2', value: 'x' } });
    await expect(loadSettings()).resolves.toBeUndefined();
  });

  it('falls back rather than throwing on a malformed environment value', () => {
    // Validation guards the form, but nothing guards a hand-edited .env, and
    // taking the transfer worker down over one typo is the wrong trade.
    process.env.ABS_SYNC_MAX_CONCURRENT = 'three';
    resetEnvCache();
    expect(getEnv().maxConcurrentSyncs).toBe(2);
  });
});
