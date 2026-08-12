import 'dotenv/config';
/**
 * Requeues transfers that have stopped, by job id or title substring.
 *
 * Keeps `spoolPath` intact, so a transfer that already downloaded its audio
 * uploads it rather than fetching gigabytes from a friend's server again. Pass
 * --fresh to discard what was downloaded and start over.
 *
 *   npm run requeue -- "spell or high water" "fight and flight"
 *   npm run requeue -- --all-failed
 *   npm run requeue -- cmsnig48q01dl7foo8fp0ek9f --fresh
 */
import { prisma } from '../lib/db.js';

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const allFailed = args.includes('--all-failed');
const needles = args.filter((arg) => !arg.startsWith('--'));

if (!allFailed && needles.length === 0) {
  console.error('usage: npm run requeue -- <job id | title substring> [...] [--fresh]');
  console.error('       npm run requeue -- --all-failed [--fresh]');
  process.exit(2);
}

const candidates = await prisma.syncJob.findMany({
  where: { status: { in: ['failed', 'canceled'] } },
  select: { id: true, title: true, status: true, spoolPath: true, attempts: true },
  orderBy: { createdAt: 'asc' },
});

const matches = allFailed
  ? candidates
  : candidates.filter((job) =>
      needles.some(
        (needle) => job.id === needle || job.title.toLowerCase().includes(needle.toLowerCase()),
      ),
    );

if (matches.length === 0) {
  console.log('nothing matched');
  process.exit(0);
}

for (const job of matches) {
  await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      status: 'queued',
      phase: 'pending',
      attempts: 0,
      error: null,
      downloadedBytes: 0,
      uploadedBytes: 0,
      finishedAt: null,
      ...(fresh ? { spoolPath: null } : {}),
    },
  });
  const spool = fresh ? 'discarding download' : job.spoolPath ? 'reusing download' : 'no download held';
  console.log(`  requeued "${job.title}" (was ${job.status}, ${job.attempts} attempt(s), ${spool})`);
}

console.log(`requeued ${matches.length} transfer(s)`);
await prisma.$disconnect();
