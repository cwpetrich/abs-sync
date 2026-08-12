import 'dotenv/config';
/**
 * Indexes servers from the command line, for headless installs where clicking
 * "Index now" in a browser is inconvenient.
 *
 *   npm run index                  # every enabled server, auto mode
 *   npm run index -- --full        # force a full reconcile
 *   npm run index -- jarom         # only servers whose name matches
 *   npm run index -- --quality     # also report metadata that cannot be matched
 */
import { prisma } from '../lib/db.js';
import { indexServer } from '../lib/indexer.js';

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reportQuality(): Promise<void> {
  console.log('\n\u001b[1mMetadata quality\u001b[0m');

  const servers = await prisma.server.findMany({ select: { id: true, name: true } });
  for (const server of servers) {
    const [total, noTitle, noAuthor, noSeries, longItems, withIds] = await Promise.all([
      prisma.indexedItem.count({ where: { serverId: server.id } }),
      // An empty normalized title has no matching signal at all: it can never be
      // recognised as already-owned, so it would sit in the diff forever.
      prisma.indexedItem.count({ where: { serverId: server.id, normTitle: '' } }),
      prisma.indexedItem.count({ where: { serverId: server.id, normAuthor: '' } }),
      prisma.indexedItem.count({ where: { serverId: server.id, normSeries: null } }),
      // Suspiciously long items are usually whole series bundled as one entry.
      prisma.indexedItem.count({ where: { serverId: server.id, durationSec: { gt: 20 * 3600 } } }),
      prisma.indexedItem.count({
        where: { serverId: server.id, OR: [{ asin: { not: null } }, { isbn: { not: null } }] },
      }),
    ]);

    if (total === 0) {
      console.log(`  ${server.name}: not indexed`);
      continue;
    }
    const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
    console.log(`  \u001b[1m${server.name}\u001b[0m  ${total} items`);
    console.log(`    unmatchable (empty normalized title): ${noTitle} (${pct(noTitle)})`);
    console.log(`    no author:                            ${noAuthor} (${pct(noAuthor)})`);
    console.log(`    no series:                            ${noSeries} (${pct(noSeries)})`);
    console.log(`    over 20h (likely bundled series):     ${longItems} (${pct(longItems)})`);
    console.log(`    has ASIN or ISBN:                     ${withIds} (${pct(withIds)})`);

    if (noTitle > 0) {
      const examples = await prisma.indexedItem.findMany({
        where: { serverId: server.id, normTitle: '' },
        select: { title: true, absItemId: true },
        take: 5,
      });
      console.log(
        `    examples: ${examples.map((e) => `${JSON.stringify(e.title)} (${e.absItemId})`).join(', ')}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const quality = args.includes('--quality');
  const filter = args.find((arg) => !arg.startsWith('-'));

  const servers = await prisma.server.findMany({
    where: { enabled: true },
    orderBy: [{ isTarget: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true },
  });
  const selected = filter
    ? servers.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()))
    : servers;

  if (selected.length === 0) {
    console.log('No matching enabled servers.');
    await prisma.$disconnect();
    return;
  }

  let failed = false;
  for (const server of selected) {
    const startedAt = Date.now();
    process.stdout.write(`Indexing ${server.name}… `);
    try {
      const summary = await indexServer(server.id, { mode: full ? 'full' : 'auto' });
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (summary.status === 'completed') {
        console.log(
          `\u001b[32mok\u001b[0m — ${summary.mode}, ${summary.itemsIndexed} indexed` +
            (summary.itemsRemoved > 0 ? `, ${summary.itemsRemoved} removed` : '') +
            `, ${summary.pageRequests} request(s), ${seconds}s` +
            (summary.escalatedBecause ? `\n    escalated: ${summary.escalatedBecause}` : ''),
        );
      } else {
        failed = true;
        console.log(`\u001b[31m${summary.status}\u001b[0m — ${summary.error ?? 'unknown error'}`);
      }
    } catch (error) {
      failed = true;
      console.log(`\u001b[31mfailed\u001b[0m — ${errText(error)}`);
    }
  }

  if (quality) await reportQuality();

  await prisma.$disconnect();
  if (failed) process.exit(1);
}

await main();
