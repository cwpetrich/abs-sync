import 'dotenv/config';
/**
 * Repoints `SyncJob.spoolPath` at the configured spool directory.
 *
 * Needed once, after the default spool location moved off `/tmp` (which Linux
 * clears on reboot, discarding downloads that are now deliberately retained for
 * retries). Only rewrites rows whose files are actually present in the new place.
 *
 *   npm run spool:fix
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../lib/db.js';
import { getEnv } from '../lib/env.js';

const root = getEnv().spoolDir;
console.log(`spool directory: ${root}`);

const jobs = await prisma.syncJob.findMany({
  where: { spoolPath: { not: null } },
  select: { id: true, title: true, spoolPath: true },
});

let updated = 0;
for (const job of jobs) {
  const expected = path.join(root, job.id);
  if (job.spoolPath === expected) continue;

  const files = await readdir(expected).catch((): string[] => []);
  if (files.length === 0) {
    console.log(`  no files at ${expected} — clearing stale path for "${job.title}"`);
    await prisma.syncJob.update({ where: { id: job.id }, data: { spoolPath: null } });
    continue;
  }

  await prisma.syncJob.update({ where: { id: job.id }, data: { spoolPath: expected } });
  console.log(`  "${job.title}": ${files.length} file(s) -> ${expected}`);
  updated++;
}

console.log(`updated ${updated} job(s)`);
await prisma.$disconnect();
