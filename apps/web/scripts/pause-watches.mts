import 'dotenv/config';
/**
 * Pauses every series watch.
 *
 * Used while the receiving server's reverse proxy rejects uploads: each watch
 * pass would otherwise re-download whole audiobooks from a friend's server only
 * to fail at the upload step. Undo with "Resume" on the Watched series page.
 *
 *   npm run watches:pause
 */
import { prisma } from '../lib/db.js';

const result = await prisma.seriesWatch.updateMany({
  where: { enabled: true },
  data: { enabled: false },
});
console.log(`paused ${result.count} watch(es)`);

const remaining = await prisma.seriesWatch.findMany({
  select: { seriesName: true, enabled: true },
  orderBy: { seriesName: 'asc' },
});
for (const watch of remaining) {
  console.log(`  ${watch.enabled ? 'active' : 'paused'}  ${watch.seriesName}`);
}

await prisma.$disconnect();
