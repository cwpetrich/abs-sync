import 'dotenv/config';
/**
 * Checks that every file abs-sync would transfer for an item is actually
 * fetchable, without transferring it.
 *
 * Enumerates the item exactly as the sync worker does, then opens each file's
 * download and cancels it after the response headers arrive. Nothing is written
 * anywhere and no meaningful bytes move.
 *
 *   npm run preflight -- <server-name-substring> <itemId> [itemId...]
 */
import { AbsClient } from '@abs-sync/abs-client';
import { formatBytes } from '@abs-sync/core';
import { credentialsFor } from '../lib/servers.js';
import { prisma } from '../lib/db.js';

const [nameFilter, ...itemIds] = process.argv.slice(2);
if (!nameFilter || itemIds.length === 0) {
  console.error('usage: npm run preflight -- <server-name> <itemId> [itemId...]');
  process.exit(2);
}

const server = await prisma.server.findFirst({ where: { name: { contains: nameFilter } } });
if (!server) {
  console.error(`no server matching "${nameFilter}"`);
  process.exit(1);
}

const credentials = credentialsFor(server);
const client = new AbsClient({
  baseUrl: server.baseUrl,
  auth:
    credentials.kind === 'apiKey'
      ? { kind: 'apiKey', apiKey: credentials.apiKey }
      : { kind: 'password', username: credentials.username, password: credentials.password },
  serverKey: `preflight:${server.id}`,
});

console.log(`\n${server.name}  ${server.baseUrl}  (${server.serverVersion ?? '?'})`);
let failures = 0;

for (const itemId of itemIds) {
  const listing = await client.listItemFilesDetailed(itemId);
  const transferable = listing.files.filter((file) => file.kind !== 'other');
  const totalBytes = transferable.reduce((sum, file) => sum + file.size, 0);

  console.log(`\n[1m${itemId}[0m`);
  console.log(
    `  ${transferable.length} file(s) to transfer, ${formatBytes(totalBytes)}` +
      `  ·  ${listing.files.filter((f) => f.kind === 'audio').length} audio`,
  );
  if (listing.staleDuplicates > 0) {
    console.log(
      `  [33m![0m ${listing.staleDuplicates} stale duplicate entr${
        listing.staleDuplicates === 1 ? 'y' : 'ies'
      } in media.audioFiles, correctly ignored`,
    );
  }
  if (listing.unfetchableAudio.length > 0) {
    failures++;
    console.log(`  [31m✗[0m ${listing.unfetchableAudio.length} audio file(s) unfetchable`);
  }

  let ok = 0;
  for (const file of transferable) {
    try {
      const handle = await client.openFileDownload(itemId, file.ino);
      await handle.stream.cancel().catch(() => undefined);
      ok++;
    } catch (error) {
      failures++;
      console.log(`  [31m✗[0m ${file.filename} (ino ${file.ino}): ${(error as Error).message}`);
    }
  }
  console.log(`  [32m✓[0m ${ok}/${transferable.length} resolved`);
}

console.log(failures === 0 ? '\n[32mall files resolve[0m' : `\n[31m${failures} problem(s)[0m`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
