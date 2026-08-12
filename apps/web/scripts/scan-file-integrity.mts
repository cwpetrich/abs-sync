import 'dotenv/config';
/**
 * Scans a server for items whose `media.audioFiles` disagrees with
 * `libraryFiles`.
 *
 * Audiobookshelf resolves `/api/items/:id/file/:ino` against `libraryFiles`, so
 * an audio file listed only under `media.audioFiles` cannot be downloaded at
 * all. Stale duplicates there also inflate the item's reported duration, which
 * corrupts duration-based matching.
 *
 * Read-only: metadata requests only, no file transfers.
 *
 *   npm run scan:files -- <server-name-substring>
 */
import { credentialsFor } from '../lib/servers.js';
import { prisma } from '../lib/db.js';
import { AbsClient } from '@abs-sync/abs-client';

const nameFilter = process.argv[2];
if (!nameFilter) {
  console.error('usage: npm run scan:files -- <server-name>');
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
  serverKey: `scan:${server.id}`,
});
const bearer = credentials.kind === 'apiKey' ? credentials.apiKey : await client.login();

const items = await prisma.indexedItem.findMany({
  where: { serverId: server.id },
  select: { absItemId: true, title: true, durationSec: true, numAudioFiles: true },
  orderBy: { title: 'asc' },
});

console.log(`${server.name}: checking ${items.length} indexed items\n`);

let checked = 0;
let clean = 0;
const duplicated: Array<{ title: string; real: number; reported: number; hours: number }> = [];
const unfetchable: Array<{ title: string; count: number }> = [];
const errors: string[] = [];

/** Simple concurrency limiter — the server should not be hammered. */
const CONCURRENCY = 6;
const queue = [...items];

async function worker() {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    try {
      const response = await fetch(`${server!.baseUrl}/api/items/${item.absItemId}?expanded=1`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      if (!response.ok) {
        errors.push(`${item.title}: ${response.status}`);
        continue;
      }
      const payload = (await response.json()) as Record<string, any>;
      const libraryFiles: any[] = payload.libraryFiles ?? [];
      const audioFiles: any[] = payload.media?.audioFiles ?? [];
      if (libraryFiles.length === 0) {
        errors.push(`${item.title}: no libraryFiles reported`);
        continue;
      }

      const knownInos = new Set(libraryFiles.map((file) => String(file.ino)));
      const knownNames = new Set(
        libraryFiles.map((file) => String(file.metadata?.relPath ?? file.metadata?.filename ?? '')),
      );
      const realAudio = libraryFiles.filter((file) => (file.fileType ?? '').toLowerCase() === 'audio').length;

      const strays = audioFiles.filter((file) => !knownInos.has(String(file.ino)));
      const stale = strays.filter((file) =>
        knownNames.has(String(file.metadata?.relPath ?? file.metadata?.filename ?? '')),
      );
      const missing = strays.length - stale.length;

      if (stale.length > 0) {
        duplicated.push({
          title: item.title,
          real: realAudio,
          reported: audioFiles.length,
          hours: (item.durationSec ?? 0) / 3600,
        });
      }
      if (missing > 0) unfetchable.push({ title: item.title, count: missing });
      if (strays.length === 0) clean++;
    } catch (error) {
      errors.push(`${item.title}: ${(error as Error).message}`);
    } finally {
      checked++;
      if (checked % 100 === 0) process.stderr.write(`  ${checked}/${items.length}\n`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`checked        ${checked}`);
console.log(`clean          ${clean}`);
console.log(`stale dupes    ${duplicated.length}   (inflated duration, 404 on download)`);
console.log(`unfetchable    ${unfetchable.length}   (audio in media.* but not libraryFiles)`);
console.log(`errors         ${errors.length}`);

if (duplicated.length > 0) {
  const inflated = duplicated.filter((entry) => entry.hours >= 20).length;
  console.log(`\nof the stale-dupe items, ${inflated} are indexed at 20h or more`);
  console.log('\nworst offenders by reported/real file ratio:');
  for (const entry of duplicated
    .sort((a, b) => b.reported / b.real - a.reported / a.real)
    .slice(0, 10)) {
    console.log(
      `  ${entry.reported} reported vs ${entry.real} real  (${entry.hours.toFixed(1)}h indexed)  ${entry.title}`,
    );
  }
}

if (unfetchable.length > 0) {
  console.log('\nitems with audio that cannot be downloaded at all:');
  for (const entry of unfetchable.slice(0, 20)) {
    console.log(`  ${entry.count} file(s)  ${entry.title}`);
  }
}

if (errors.length > 0) {
  console.log('\nerrors:');
  for (const error of errors.slice(0, 10)) console.log(`  ${error}`);
}

await prisma.$disconnect();
