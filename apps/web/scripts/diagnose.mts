import 'dotenv/config';
/**
 * Live server diagnostics.
 *
 * Probes every Audiobookshelf endpoint the sync path depends on, against the
 * real servers stored in the database, and reports which URL shapes and payload
 * fields this server version actually provides.
 *
 * Read-only by design: it downloads at most one byte per file probe (the stream
 * is cancelled immediately) and never writes to a remote server. Uploading is
 * covered by a separate, explicitly opt-in script.
 *
 * Credentials are read from the encrypted database, never from arguments, so
 * they never appear in a shell history or a terminal transcript.
 *
 *   npm run diagnose            # every enabled server
 *   npm run diagnose -- <name>  # just servers whose name contains <name>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AbsClient } from '@abs-sync/abs-client';
import { absItemToBookRecord } from '@abs-sync/abs-client';
import { createHash } from 'node:crypto';
import { decryptJson } from '../lib/crypto.js';
import { prisma } from '../lib/db.js';
import { getEnv } from '../lib/env.js';
import { clientFor, type ServerCredentials } from '../lib/servers.js';

/**
 * Identifies a secret without revealing any of it. A masked form like
 * "abcd****wxyz" still leaks characters into terminal output and logs, so use a
 * salted digest prefix instead — enough to tell two credentials apart, useless
 * to anyone reading over your shoulder.
 */
function fingerprint(secret: string): string {
  const digest = createHash('sha256').update(`abs-sync/fingerprint:${secret}`).digest('hex');
  return `${secret.length} chars, id ${digest.slice(0, 8)}`;
}

type Verdict = 'pass' | 'warn' | 'fail' | 'skip';

const ICON: Record<Verdict, string> = {
  pass: '\u001b[32m✓\u001b[0m',
  warn: '\u001b[33m!\u001b[0m',
  fail: '\u001b[31m✗\u001b[0m',
  skip: '\u001b[90m-\u001b[0m',
};

let failures = 0;
let warnings = 0;

function report(verdict: Verdict, label: string, detail = ''): void {
  if (verdict === 'fail') failures++;
  if (verdict === 'warn') warnings++;
  console.log(`  ${ICON[verdict]} ${label}${detail ? `\n      ${detail}` : ''}`);
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the raw SQLite file and confirms a plaintext secret is not in it. */
async function assertNotOnDisk(dbPath: string, secrets: string[]): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readFile(dbPath);
  } catch (error) {
    report('warn', 'Database file scan', `could not read ${dbPath}: ${errText(error)}`);
    return;
  }

  const haystack = raw.toString('latin1');
  for (const secret of secrets) {
    if (!secret) continue;
    if (haystack.includes(secret)) {
      report(
        'fail',
        `Plaintext leak for credential [${fingerprint(secret)}]`,
        `found verbatim in ${path.basename(dbPath)} — credentials are NOT encrypted at rest`,
      );
    } else {
      report('pass', `credential [${fingerprint(secret)}] is not recoverable from the database file`);
    }
  }
}

/** How many items to check for file-listing inconsistencies. */
const INTEGRITY_SAMPLE = 12;
/** How many files per item to actually resolve, spread across the list. */
const RESOLVE_PER_ITEM = 3;

/**
 * Checks whether `media.audioFiles` agrees with `libraryFiles`, across a spread
 * of items rather than one.
 *
 * Audiobookshelf resolves `/api/items/:id/file/:ino` against `libraryFiles`, so
 * an ino present only in `media.audioFiles` cannot be downloaded at all. A
 * remount that changes inode numbers leaves every file listed twice, and a
 * single-item single-file probe sails straight past it: the first ino in the
 * list is usually one of the good ones.
 */
async function probeFileListingIntegrity(
  client: AbsClient,
  libraryId: string,
  canDownload: boolean,
): Promise<void> {
  let itemIds: string[];
  try {
    const page = await client.listLibraryItems(libraryId, {
      page: 0,
      limit: INTEGRITY_SAMPLE,
      minified: true,
    });
    itemIds = (page.results ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
  } catch (error) {
    report('warn', 'File listing integrity', `could not sample items: ${errText(error)}`);
    return;
  }
  if (itemIds.length === 0) {
    report('skip', 'File listing integrity', 'no items to sample');
    return;
  }

  let withStaleDuplicates = 0;
  let withUnfetchable = 0;
  let totalStale = 0;
  let checked = 0;
  let resolveFailures = 0;
  let resolveAttempts = 0;
  let example: string | null = null;

  for (const itemId of itemIds) {
    let listing;
    try {
      listing = await client.listItemFilesDetailed(itemId);
    } catch {
      continue;
    }
    checked++;
    if (listing.staleDuplicates > 0) {
      withStaleDuplicates++;
      totalStale += listing.staleDuplicates;
      example ??= itemId;
    }
    if (listing.unfetchableAudio.length > 0) withUnfetchable++;

    if (!canDownload) continue;
    // Sample across the list, not just the front, where the good inos sit.
    const audio = listing.files.filter((file) => file.kind === 'audio');
    const step = Math.max(1, Math.floor(audio.length / RESOLVE_PER_ITEM));
    for (let index = 0; index < audio.length; index += step) {
      const file = audio[index]!;
      resolveAttempts++;
      try {
        const handle = await client.openFileDownload(itemId, file.ino);
        await handle.stream.cancel().catch(() => undefined);
      } catch {
        resolveFailures++;
      }
    }
  }

  if (checked === 0) {
    report('warn', 'File listing integrity', 'no sampled item could be enumerated');
    return;
  }

  if (withStaleDuplicates > 0) {
    report(
      'warn',
      'File listing integrity',
      `${withStaleDuplicates}/${checked} sampled items list files twice in media.audioFiles ` +
        `(${totalStale} stale entries; e.g. item ${example}). abs-sync ignores them, but this server ` +
        'reports inflated duration and file counts for those items. Re-scanning the library on that ' +
        'server rebuilds the audio file list from what is on disk.',
    );
  } else {
    report('pass', 'File listing integrity', `${checked} sampled items agree with libraryFiles`);
  }

  if (withUnfetchable > 0) {
    report(
      'fail',
      'Unfetchable audio',
      `${withUnfetchable}/${checked} sampled items list audio that is in no file listing and cannot ` +
        'be downloaded; transfers of those items will refuse to run rather than upload a partial book',
    );
  }

  if (resolveAttempts > 0) {
    report(
      resolveFailures === 0 ? 'pass' : 'fail',
      'Per-file resolution across the sample',
      `${resolveAttempts - resolveFailures}/${resolveAttempts} sampled audio files resolved`,
    );
  }
}

async function probeServer(serverRow: Awaited<ReturnType<typeof prisma.server.findMany>>[number]) {
  console.log(`\n\u001b[1m${serverRow.name}\u001b[0m  ${serverRow.baseUrl}`);
  console.log(`  auth: ${serverRow.authKind}${serverRow.isTarget ? ' · sync target' : ''}`);

  const client: AbsClient = clientFor(serverRow);

  // --- reachability & identity ---------------------------------------------
  let serverVersion: string | null = null;
  try {
    const status = await client.getStatus();
    serverVersion = status.serverVersion ?? null;
    report('pass', 'GET /status', `Audiobookshelf ${serverVersion ?? 'version not reported'}`);
    if (serverVersion) {
      const [major, minor] = serverVersion.split('.').map(Number);
      const supportsApiKeys = (major ?? 0) > 2 || ((major ?? 0) === 2 && (minor ?? 0) >= 26);
      if (serverRow.authKind === 'apiKey' && !supportsApiKeys) {
        report('warn', 'API key support', `${serverVersion} predates 2.26.0, where API keys landed`);
      }
    }
  } catch (error) {
    report('fail', 'GET /status', errText(error));
    return;
  }

  let identity;
  try {
    identity = await client.verify();
    report(
      'pass',
      'GET /api/me',
      `${identity.user.username ?? '?'}${identity.isAdmin ? ' (admin)' : ''} · download=${
        identity.canDownload
      } upload=${identity.canUpload}`,
    );
  } catch (error) {
    report('fail', 'GET /api/me', errText(error));
    return;
  }

  if (serverRow.isTarget && !identity.canUpload) {
    report('fail', 'Target upload permission', 'this server cannot receive books');
  }
  if (!serverRow.isTarget && !identity.canDownload) {
    report('warn', 'Download permission', 'books cannot be pulled from this server');
  }

  // --- libraries -----------------------------------------------------------
  let libraries;
  try {
    libraries = await client.getLibraries();
    const bookLibraries = libraries.filter((l) => !l.mediaType || l.mediaType === 'book');
    report(
      'pass',
      'GET /api/libraries',
      `${bookLibraries.length} book librar${bookLibraries.length === 1 ? 'y' : 'ies'}: ` +
        bookLibraries.map((l) => `${l.name} (${l.folders?.length ?? 0} folder(s))`).join(', '),
    );
    const noFolder = bookLibraries.filter((l) => (l.folders?.length ?? 0) === 0);
    if (noFolder.length > 0) {
      report(
        serverRow.isTarget ? 'fail' : 'warn',
        'Upload folders',
        `no folder reported for: ${noFolder.map((l) => l.name).join(', ')}` +
          (serverRow.isTarget ? ' — uploads need a folder id' : ''),
      );
    }
  } catch (error) {
    report('fail', 'GET /api/libraries', errText(error));
    return;
  }

  const library = libraries.find((l) => (!l.mediaType || l.mediaType === 'book') && l.id);
  if (!library?.id) {
    report('skip', 'Library item probes', 'no book library to sample');
    return;
  }

  // --- paged listing (the indexer's hot path) ------------------------------
  let sampleItemId: string | null = null;
  try {
    const page = await client.listLibraryItems(library.id, { page: 0, limit: 5, minified: true });
    const results = page.results ?? [];
    report(
      'pass',
      'GET /api/libraries/:id/items?minified=1',
      `total=${page.total ?? '?'} · returned ${results.length}`,
    );

    const mapped = results
      .map((item) => absItemToBookRecord(serverRow.id, item, library.id))
      .filter((record) => record !== null);
    if (mapped.length === 0 && results.length > 0) {
      report('fail', 'Item mapping', 'no item in the sample could be mapped to a book record');
    } else if (mapped.length > 0) {
      const first = mapped[0]!;
      sampleItemId = first.itemId;
      report(
        'pass',
        'Item mapping',
        `"${first.title}" · authors=[${first.authors.join(', ')}] · ` +
          `series=${first.series.map((s) => `${s.name}#${s.sequence ?? '-'}`).join(', ') || 'none'} · ` +
          `${first.durationSec ?? '?'}s · audio=${first.hasAudio}`,
      );

      // Whether minified payloads carry identifiers decides if `enrich` is worth
      // the extra request per item.
      const withIds = mapped.filter((record) => record.asin || record.isbn).length;
      report(
        withIds > 0 ? 'pass' : 'warn',
        'Identifiers in minified listing',
        withIds > 0
          ? `${withIds}/${mapped.length} sampled items carry ASIN/ISBN`
          : 'none present — matching will rely on title/author/duration, or use enrich',
      );

      const missingAuthor = mapped.filter((record) => record.authors.length === 0).length;
      if (missingAuthor > 0) {
        report('warn', 'Author metadata', `${missingAuthor}/${mapped.length} sampled items have no author`);
      }
      const suspiciousSplit = mapped.filter((record) =>
        record.authors.some((author) => !author.includes(' ') && record.authors.length > 1),
      );
      if (suspiciousSplit.length > 0) {
        report(
          'warn',
          'Author name splitting',
          `possible "Last, First" mis-split on: ${suspiciousSplit
            .map((record) => `${record.title} -> [${record.authors.join(' | ')}]`)
            .slice(0, 3)
            .join('; ')}`,
        );
      }
    }
  } catch (error) {
    report('fail', 'GET /api/libraries/:id/items', errText(error));
  }

  // --- incremental indexing capability ------------------------------------
  // Incremental indexing depends on the server honouring a newest-first sort.
  // Each candidate is validated against the field it sorts by, at the same page
  // size the indexer uses — a small sample can look ordered by luck.
  try {
    const honoured: string[] = [];
    const ignored: string[] = [];
    for (const candidate of AbsClient.MODIFIED_SORT_CANDIDATES) {
      const probe = await client.fetchBooksModifiedSince(library.id, {
        // Far future: nothing matches, so this is one cheap page that still
        // proves whether the ordering is respected.
        since: Date.now() + 365 * 86_400_000,
        sortField: candidate,
        pageSize: 100,
        maxPages: 1,
      });
      (probe.ordered ? honoured : ignored).push(candidate);
    }

    if (honoured.length > 0) {
      report(
        'pass',
        'Incremental indexing',
        `honoured: ${honoured.join(', ')}${ignored.length > 0 ? ` · ignored: ${ignored.join(', ')}` : ''}` +
          (honoured.includes('mtimeMs')
            ? ''
            : ' — note: addedAt only moves when a book is added, so metadata edits ' +
              'are caught by the periodic full reconcile rather than incrementally'),
      );
    } else {
      report(
        'warn',
        'Incremental indexing',
        'no newest-first sort key is honoured, so every index will be a full crawl ' +
          '(correct, just slower)',
      );
    }
  } catch (error) {
    report('warn', 'Incremental indexing', errText(error));
  }

  // --- series --------------------------------------------------------------
  try {
    const series = await client.listSeries(library.id, { limit: 5 });
    report('pass', 'GET /api/libraries/:id/series', `total=${series.total ?? '?'}`);
  } catch (error) {
    report('warn', 'GET /api/libraries/:id/series', errText(error));
  }

  if (!sampleItemId) {
    report('skip', 'Per-item probes', 'no sample item id');
    return;
  }

  // --- full item + file enumeration (what the transfer worker needs) -------
  let files;
  try {
    const listing = await client.listItemFilesDetailed(sampleItemId);
    files = listing.files;
    const audio = files.filter((f) => f.kind === 'audio');
    const sized = files.filter((f) => f.size > 0);
    report(
      audio.length > 0 ? 'pass' : 'fail',
      'File enumeration (GET /api/items/:id?expanded=1)',
      audio.length > 0
        ? `${files.length} file(s), ${audio.length} audio · kinds: ${[
            ...new Set(files.map((f) => f.kind)),
          ].join(', ')}`
        : 'no audio files reported — transfers from this server would refuse to run',
    );
    if (files.length > 0 && sized.length === 0) {
      report(
        'warn',
        'File sizes',
        'no file reports a size; the truncation check and progress bars will be less useful',
      );
    }
  } catch (error) {
    report('fail', 'File enumeration', errText(error));
    return;
  }

  await probeFileListingIntegrity(client, library.id, identity.canDownload);

  // --- download URL shapes -------------------------------------------------
  const audioFile = files.find((f) => f.kind === 'audio');
  if (audioFile && identity.canDownload) {
    try {
      const handle = await client.openFileDownload(sampleItemId, audioFile.ino);
      // Cancel immediately: this is a reachability probe, not a transfer.
      await handle.stream.cancel().catch(() => undefined);
      report(
        'pass',
        'Per-file download',
        `${handle.endpoint} · ${handle.contentLength ?? '?'} bytes · ${handle.contentType ?? 'no type'}`,
      );
    } catch (error) {
      report('fail', 'Per-file download', errText(error));
    }
  } else {
    report('skip', 'Per-file download', identity.canDownload ? 'no audio file' : 'no download permission');
  }

  if (identity.canDownload) {
    try {
      const handle = await client.openDownload(sampleItemId, { libraryId: library.id });
      await handle.stream.cancel().catch(() => undefined);
      report(
        'pass',
        'Whole-item download shape',
        `${handle.endpoint} · ${handle.contentType ?? 'no type'} (informational; the worker uses per-file)`,
      );
    } catch (error) {
      report('warn', 'Whole-item download shape', errText(error));
    }
  }

  // --- cover ---------------------------------------------------------------
  try {
    const cover = await client.fetchCover(sampleItemId);
    await cover.body?.cancel().catch(() => undefined);
    report('pass', 'Cover proxy source', cover.headers.get('content-type') ?? 'no content-type');
  } catch (error) {
    report('warn', 'Cover proxy source', errText(error));
  }

  // --- playback (used by the mobile app) -----------------------------------
  try {
    const session = await client.play(sampleItemId, { forceDirectPlay: true });
    const tracks = session.audioTracks ?? [];
    report(
      tracks.length > 0 ? 'pass' : 'warn',
      'POST /api/items/:id/play',
      `${tracks.length} track(s)${tracks[0]?.contentUrl ? ` · first: ${tracks[0].contentUrl}` : ''}`,
    );
  } catch (error) {
    report('warn', 'POST /api/items/:id/play', errText(error));
  }
}

async function main(): Promise<void> {
  const filter = process.argv.slice(2).find((arg) => !arg.startsWith('-'));

  let env;
  try {
    env = getEnv();
  } catch (error) {
    console.error(`\nConfiguration problem: ${errText(error)}\n`);
    process.exit(1);
  }

  const servers = await prisma.server.findMany({ orderBy: [{ isTarget: 'desc' }, { name: 'asc' }] });
  const selected = filter
    ? servers.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()))
    : servers;

  if (selected.length === 0) {
    console.log(
      servers.length === 0
        ? '\nNo servers in the database yet. Add them in the UI first (http://localhost:3000/servers).\n'
        : `\nNo server name matched "${filter}". Known: ${servers.map((s) => s.name).join(', ')}\n`,
    );
    await prisma.$disconnect();
    return;
  }

  console.log(`\n\u001b[1mCredential storage\u001b[0m`);
  const secrets: string[] = [];
  for (const server of selected) {
    try {
      const credentials = decryptJson<ServerCredentials>(server.secretCipher);
      const secret = credentials.kind === 'apiKey' ? credentials.apiKey : credentials.password;
      secrets.push(secret);
      report(
        'pass',
        `${server.name}: credential decrypts`,
        `${credentials.kind} · ${fingerprint(secret)}` +
          (credentials.kind === 'password' ? ' · username stored' : ''),
      );
      if (!server.secretCipher.startsWith('v1:')) {
        report('fail', `${server.name}: ciphertext format`, 'not the expected versioned envelope');
      }
      if (server.tokenCipher) {
        const token = decryptJson<string>(server.tokenCipher);
        secrets.push(token);
        report('pass', `${server.name}: cached login token decrypts`, fingerprint(token));
      }
    } catch (error) {
      report('fail', `${server.name}: credential decrypts`, errText(error));
    }
  }

  const dbPath = env.databaseUrl.replace(/^file:/, '');
  await assertNotOnDisk(path.resolve(dbPath), secrets);

  for (const server of selected) {
    await probeServer(server);
  }

  console.log(
    `\n\u001b[1mSummary\u001b[0m  ${failures} failure(s), ${warnings} warning(s) across ${selected.length} server(s)\n`,
  );
  await prisma.$disconnect();
  if (failures > 0) process.exit(1);
}

await main();
