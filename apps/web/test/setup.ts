import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test bootstrap.
 *
 * Runs before any test file imports `lib/db`, so the environment is fully in
 * place by the time the Prisma client is constructed. Each worker gets a fresh
 * SQLite file and a fresh spool directory.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

const workerId = process.env.VITEST_WORKER_ID ?? '0';
const dbPath = path.join(appRoot, `test-${workerId}.db`);
const spoolDir = mkdtempSync(path.join(os.tmpdir(), 'abs-sync-test-spool-'));

// Start from a clean database every run so tests never inherit stale rows.
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}

process.env.DATABASE_URL = `file:${dbPath}`;
process.env.ABS_SYNC_SECRET = 'test-secret-that-is-definitely-long-enough-1234567890';
process.env.ABS_SYNC_SPOOL_DIR = spoolDir;
process.env.ABS_SYNC_MAX_CONCURRENT = '2';
process.env.ABS_SYNC_WATCH_INTERVAL_MINUTES = '60';

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: appRoot,
  env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
  stdio: 'pipe',
});
