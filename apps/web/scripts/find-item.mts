import 'dotenv/config';
/**
 * Searches a server's included libraries for items whose title contains a
 * phrase, printing id, size, file count and when it was added.
 *
 * Read-only. Written to answer "what actually landed?" after an upload, and in
 * particular whether a retry created a duplicate item.
 *
 *   npm run find -- "mark of the fool 10"
 *   npm run find -- "mark of the fool" --server conrad
 */
import type { AbsLibraryItem } from '@abs-sync/abs-client';
import { formatBytes } from '@abs-sync/core';
import { prisma } from '../lib/db.js';
import { clientFor } from '../lib/servers.js';

const args = process.argv.slice(2);
const serverIndex = args.indexOf('--server');
const serverFilter = serverIndex === -1 ? null : args[serverIndex + 1]?.toLowerCase();
const phrase = args
  .filter((arg, index) => index !== serverIndex && index !== serverIndex + 1)
  .join(' ')
  .trim();

if (!phrase) {
  console.error('usage: npm run find -- "<title phrase>" [--server <name>]');
  process.exit(2);
}

const needle = phrase.toLowerCase();
const servers = await prisma.server.findMany({
  where: { enabled: true },
  include: { libraries: { where: { included: true } } },
  orderBy: { name: 'asc' },
});

function titleOf(item: AbsLibraryItem): string {
  return item.media?.metadata?.title ?? '';
}

for (const server of servers) {
  if (serverFilter && !server.name.toLowerCase().includes(serverFilter)) continue;
  const client = clientFor(server);

  for (const library of server.libraries) {
    const hits: AbsLibraryItem[] = [];
    for (let page = 0; page < 200; page++) {
      const batch = await client.listLibraryItems(library.absId, {
        page,
        limit: 200,
        minified: true,
        sort: 'media.metadata.title',
      });
      const results = batch.results ?? [];
      if (results.length === 0) break;
      hits.push(...results.filter((item) => titleOf(item).toLowerCase().includes(needle)));
    }
    if (hits.length === 0) continue;

    console.log(`\n${server.name} / ${library.name} — ${hits.length} match(es)`);
    for (const hit of hits) {
      const added = hit.addedAt ? new Date(hit.addedAt).toISOString() : '?';
      const size = typeof hit.size === 'number' ? formatBytes(hit.size) : 'size unknown';
      console.log(`  ${hit.id}  ${titleOf(hit)}`);
      console.log(
        `    ${hit.media?.metadata?.authorName ?? 'no author'} · ${size} · added ${added}` +
          `\n    ${hit.relPath ?? hit.path ?? 'no path'}`,
      );
      const listing = await client.listItemFilesDetailed(hit.id ?? '');
      const audio = listing.files.filter((file) => file.kind === 'audio').length;
      console.log(`    ${listing.files.length} file(s), ${audio} audio`);
    }
  }
}

await prisma.$disconnect();
