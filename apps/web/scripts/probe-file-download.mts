import 'dotenv/config';
/**
 * Probes the per-file download endpoints for a specific library item.
 *
 * Read-only: every request asks for a single byte (`Range: bytes=0-0`) and the
 * body is discarded, so nothing meaningful is transferred and nothing is
 * written to the remote server.
 *
 *   npm run probe:file -- <server-name-substring> <itemId> [itemId...]
 */
import { AbsClient } from '@abs-sync/abs-client';
import { credentialsFor } from '../lib/servers.js';
import { prisma } from '../lib/db.js';

const [nameFilter, ...itemIds] = process.argv.slice(2);
if (!nameFilter || itemIds.length === 0) {
  console.error('usage: npm run probe:file -- <server-name> <itemId> [itemId...]');
  process.exit(2);
}

const server = await prisma.server.findFirst({
  where: { name: { contains: nameFilter } },
});
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
  serverKey: `probe:${server.id}`,
});

/** Bearer value for direct fetches, so we can try arbitrary URL shapes. */
const bearer = credentials.kind === 'apiKey' ? credentials.apiKey : await client.login();

async function probe(label: string, url: string, headers: Record<string, string> = {}) {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${bearer}`, accept: '*/*', range: 'bytes=0-0', ...headers },
    });
    const type = response.headers.get('content-type') ?? '-';
    const disposition = response.headers.get('content-disposition') ?? '-';
    const length = response.headers.get('content-length') ?? '-';
    let body = '';
    if (!response.ok && response.status !== 206) {
      body = (await response.text()).slice(0, 120).replace(/\s+/g, ' ');
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    const flag = response.ok || response.status === 206 ? '[32mOK [0m' : '[31mBAD[0m';
    console.log(
      `  ${flag} ${String(response.status).padEnd(4)} ${label}\n       type=${type} len=${length} disp=${disposition}${
        body ? `\n       body=${body}` : ''
      }`,
    );
    return response.status;
  } catch (error) {
    console.log(`  [31mERR[0m      ${label}\n       ${(error as Error).message}`);
    return -1;
  }
}

console.log(`\n${server.name}  ${server.baseUrl}  (${server.serverVersion ?? '?'}, auth=${server.authKind})`);

for (const itemId of itemIds) {
  console.log(`\n[1mitem ${itemId}[0m`);

  const raw = await fetch(`${server.baseUrl}/api/items/${itemId}?expanded=1`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!raw.ok) {
    console.log(`  cannot fetch item: ${raw.status} ${raw.statusText}`);
    continue;
  }
  const item = (await raw.json()) as Record<string, any>;
  console.log(
    `  title=${item.media?.metadata?.title} libraryId=${item.libraryId} isMissing=${item.isMissing} isInvalid=${item.isInvalid}`,
  );
  console.log(`  relPath=${item.relPath} path=${item.path}`);

  const libraryFiles: any[] = item.libraryFiles ?? [];
  console.log(`  libraryFiles: ${libraryFiles.length}`);
  for (const file of libraryFiles.slice(0, 4)) {
    console.log(
      `    ino=${JSON.stringify(file.ino)} type=${file.fileType} name=${file.metadata?.filename} size=${file.metadata?.size} relPath=${file.metadata?.relPath}`,
    );
  }

  const audioFiles: any[] = item.media?.audioFiles ?? [];
  console.log(`  media.audioFiles: ${audioFiles.length}`);
  for (const file of audioFiles.slice(0, 3)) {
    console.log(
      `    ino=${JSON.stringify(file.ino)} index=${file.index} name=${file.metadata?.filename} size=${file.metadata?.size}`,
    );
  }

  const tracks: any[] = item.media?.tracks ?? [];
  console.log(`  media.tracks: ${tracks.length}`);
  for (const track of tracks.slice(0, 3)) {
    console.log(`    ino=${JSON.stringify(track.ino)} index=${track.index} contentUrl=${track.contentUrl}`);
  }

  const first = libraryFiles.find((f) => f.fileType === 'audio') ?? libraryFiles[0] ?? audioFiles[0];
  if (!first) {
    console.log('  no files to probe');
    continue;
  }
  const ino = String(first.ino);
  const relPath: string | undefined = first.metadata?.relPath ?? first.metadata?.filename;

  console.log(`  probing ino=${ino} relPath=${relPath}`);
  const b = server.baseUrl;
  await probe('/api/items/:id/file/:ino/download', `${b}/api/items/${itemId}/file/${ino}/download`);
  await probe('/api/items/:id/file/:ino', `${b}/api/items/${itemId}/file/${ino}`);
  await probe(
    '/api/items/:id/file/:ino/download?token=',
    `${b}/api/items/${itemId}/file/${ino}/download?token=${encodeURIComponent(bearer)}`,
  );
  if (relPath) {
    const clean = relPath.replace(/^\/+/, '');
    await probe(
      '/api/items/:id/file/:relPath (path form)',
      `${b}/api/items/${itemId}/file/${clean.split('/').map(encodeURIComponent).join('/')}`,
    );
  }
  if (tracks[0]?.contentUrl) {
    const url: string = tracks[0].contentUrl;
    await probe(`track.contentUrl (${url.slice(0, 48)}…)`, `${b}${url.startsWith('/') ? '' : '/'}${url}`);
  }
  await probe('/api/items/:id/download (whole item)', `${b}/api/items/${itemId}/download`);
}

await prisma.$disconnect();
