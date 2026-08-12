import { MockAbsServer, type MockFile, type MockItemInput } from '@abs-sync/abs-client/mock-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { compare } from '../lib/compare';
import { prisma } from '../lib/db';
import { indexServer } from '../lib/indexer';
import { createServer, listServers, setTargetServer } from '../lib/servers';
import { cancelJob, clearFinishedJobs, enqueueSync, getWorker, listJobs } from '../lib/sync-worker';
import { createWatch, evaluateWatch, suggestSeriesToWatch } from '../lib/watches';
import { installFetchRouter } from './fetch-router';

const router = installFetchRouter();

/**
 * Password for the username/password mock. Deliberately long and containing a
 * hyphen: the encryption assertions check that the plaintext does not appear in
 * the stored ciphertext, and a two-character secret shows up inside random
 * base64 often enough to fail the test by coincidence. A hyphen cannot appear in
 * base64 at all, so a match here can only mean a real leak.
 */
const OTHER_PASSWORD = 'other-pw-not-in-base64';

function bytes(text: string, repeat = 1): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text.repeat(repeat));
}

function audioFiles(prefix: string, count: number): MockFile[] {
  const files: MockFile[] = [];
  for (let index = 1; index <= count; index++) {
    files.push({
      ino: `${prefix}-ino-${index}`,
      filename: `${prefix} - ${String(index).padStart(2, '0')}.mp3`,
      fileType: 'audio',
      // Repeat so the payload spans several stream chunks.
      content: bytes(`AUDIO:${prefix}:${index};`, 40),
    });
  }
  files.push({
    ino: `${prefix}-cover`,
    filename: 'cover.jpg',
    fileType: 'image',
    content: bytes('JPEGDATA', 4),
  });
  files.push({
    ino: `${prefix}-nfo`,
    filename: 'notes.nfo',
    fileType: 'metadata',
    content: bytes('SIDECAR'),
  });
  return files;
}

/** Books my own server already has. */
const MINE: MockItemInput[] = [
  {
    id: 'mine-1',
    title: 'The Way of Kings',
    authorName: 'Brandon Sanderson',
    seriesName: 'The Stormlight Archive #1',
    duration: 160_000,
    size: 1_200_000,
  },
  {
    id: 'mine-2',
    title: 'Project Hail Mary',
    authorName: 'Andy Weir',
    duration: 58_000,
    size: 500_000,
  },
];

/** Books on a friend's server. */
const FRIEND: MockItemInput[] = [
  {
    // Same book as mine-1, titled differently — must be detected as present.
    id: 'friend-1',
    title: 'The Way of Kings: Book One of the Stormlight Archive',
    authorName: 'Sanderson, Brandon',
    seriesName: 'Stormlight Archive #1',
    duration: 160_400,
    size: 1_210_000,
  },
  {
    id: 'friend-2',
    title: 'Words of Radiance',
    authorName: 'Brandon Sanderson',
    seriesName: 'The Stormlight Archive #2',
    duration: 170_000,
    size: 1_300_000,
    numTracks: 3,
    files: audioFiles('wor', 3),
  },
  {
    id: 'friend-3',
    title: 'Neuromancer',
    authorName: 'William Gibson',
    duration: 36_000,
    size: 400_000,
    numTracks: 1,
    files: audioFiles('neuro', 1),
  },
  {
    // Ebook-only: no audio files at all, must be skipped by the diff.
    id: 'friend-4',
    title: 'Snow Crash',
    authorName: 'Neal Stephenson',
    duration: 0,
    numTracks: 0,
  },
];

/** A second friend offering a duplicate of one missing book, plus a new one. */
const OTHER: MockItemInput[] = [
  {
    id: 'other-1',
    title: 'Words of Radiance (Unabridged)',
    authorName: 'Brandon Sanderson',
    seriesName: 'Stormlight Archive #2',
    duration: 170_200,
    // Larger, so this copy should win as the representative.
    size: 1_900_000,
    numTracks: 2,
    files: audioFiles('wor-alt', 2),
  },
  {
    id: 'other-2',
    title: 'Oathbringer',
    authorName: 'Brandon Sanderson',
    seriesName: 'The Stormlight Archive #3',
    duration: 200_000,
    size: 2_000_000,
    numTracks: 2,
    files: audioFiles('oath', 2),
  },
];

let mineServer: MockAbsServer;
let friendServer: MockAbsServer;
let otherServer: MockAbsServer;
let mineId: string;
let friendId: string;
let otherId: string;

async function waitForJob(jobId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`job ${jobId} vanished`);
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'canceled') {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} did not finish: status=${job.status} error=${job.error}`);
    }
    // Nudge the worker in case no tick is scheduled.
    void getWorker().tick();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  mineServer = router.register(
    new MockAbsServer({ baseUrl: 'https://mine.abs.test', apiKeys: ['mine-key'] }),
  );
  mineServer.addLibrary('mine-lib', 'Audiobooks', MINE);

  friendServer = router.register(
    new MockAbsServer({ baseUrl: 'https://friend.abs.test', apiKeys: ['friend-key'] }),
  );
  friendServer.addLibrary('friend-lib', 'Audiobooks', FRIEND);

  otherServer = router.register(
    new MockAbsServer({
      baseUrl: 'https://other.abs.test',
      users: [{ username: 'conrad', password: OTHER_PASSWORD, token: 'other-token', type: 'admin' }],
      apiKeys: [],
    }),
  );
  otherServer.addLibrary('other-lib', 'Audiobooks', OTHER);

  const mine = await createServer({
    name: 'Mine',
    baseUrl: 'https://mine.abs.test',
    credentials: { kind: 'apiKey', apiKey: 'mine-key' },
    isTarget: true,
  });
  const friend = await createServer({
    name: 'Friend',
    baseUrl: 'https://friend.abs.test',
    credentials: { kind: 'apiKey', apiKey: 'friend-key' },
  });
  const other = await createServer({
    name: 'Other',
    baseUrl: 'https://other.abs.test',
    credentials: { kind: 'password', username: 'conrad', password: OTHER_PASSWORD },
  });

  mineId = mine.id;
  friendId = friend.id;
  otherId = other.id;

  for (const id of [mineId, friendId, otherId]) {
    const summary = await indexServer(id);
    expect(summary.status, `index of ${id}: ${summary.error}`).toBe('completed');
  }
});

afterAll(async () => {
  getWorker().stop();
  await prisma.$disconnect();
  router.restore();
});

describe('server registration', () => {
  it('stores credentials encrypted, never in plaintext', async () => {
    const rows = await prisma.server.findMany();
    for (const row of rows) {
      expect(row.secretCipher).toMatch(/^v1:/);
      expect(row.secretCipher).not.toContain('mine-key');
      expect(row.secretCipher).not.toContain('friend-key');
      expect(row.secretCipher).not.toContain(OTHER_PASSWORD);
    }
  });

  it('caches the login token for password auth', async () => {
    const row = await prisma.server.findUnique({ where: { id: otherId } });
    expect(row?.authKind).toBe('password');
    expect(row?.tokenCipher).toMatch(/^v1:/);
    expect(row?.tokenCipher).not.toContain('other-token');
  });

  it('discovers libraries and their upload folders', async () => {
    const servers = await listServers();
    const mine = servers.find((server) => server.id === mineId)!;
    expect(mine.isTarget).toBe(true);
    expect(mine.canUpload).toBe(true);
    expect(mine.libraries).toHaveLength(1);
    expect(mine.libraries[0]!.folders[0]!.id).toBe('mine-lib-folder');
  });

  it('rejects a server whose credential does not work', async () => {
    await expect(
      createServer({
        name: 'Bad',
        baseUrl: 'https://friend.abs.test',
        credentials: { kind: 'apiKey', apiKey: 'nope' },
      }),
    ).rejects.toThrow(/Could not connect/);
  });
});

describe('indexing', () => {
  it('indexes only book items that exist', async () => {
    const mineItems = await prisma.indexedItem.count({ where: { serverId: mineId } });
    const friendItems = await prisma.indexedItem.count({ where: { serverId: friendId } });
    expect(mineItems).toBe(MINE.length);
    expect(friendItems).toBe(FRIEND.length);
  });

  it('stores normalized columns for matching', async () => {
    const row = await prisma.indexedItem.findFirst({
      where: { serverId: friendId, absItemId: 'friend-2' },
    });
    expect(row?.normTitle).toBe('words of radiance');
    expect(row?.normAuthor).toBe('brandon sanderson');
    expect(row?.normSeries).toBe('stormlight archive');
  });

  it('prunes items that disappear upstream and is idempotent', async () => {
    const before = await prisma.indexedItem.findMany({
      where: { serverId: friendId },
      select: { id: true, absItemId: true },
      orderBy: { absItemId: 'asc' },
    });

    // Re-indexing unchanged data must not duplicate or churn rows. Explicitly
    // full, since this is asserting full-crawl reconcile semantics.
    const again = await indexServer(friendId, { mode: 'full' });
    expect(again.status).toBe('completed');
    expect(again.mode).toBe('full');
    expect(again.itemsRemoved).toBe(0);

    const after = await prisma.indexedItem.findMany({
      where: { serverId: friendId },
      select: { id: true, absItemId: true },
      orderBy: { absItemId: 'asc' },
    });
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  });

  it('records the run', async () => {
    const run = await prisma.indexRun.findFirst({
      where: { serverId: friendId, mode: 'full' },
      orderBy: { startedAt: 'desc' },
    });
    expect(run?.status).toBe('completed');
    expect(run?.itemsIndexed).toBe(FRIEND.length);
  });
});

describe('incremental indexing', () => {
  const LATER = 1_700_000_000_000 + 90 * 86_400_000;

  it('first index of a server is always a full crawl', async () => {
    const run = await prisma.indexRun.findFirst({
      where: { serverId: friendId },
      orderBy: { startedAt: 'asc' },
    });
    expect(run?.mode).toBe('full');
    const server = await prisma.server.findUnique({ where: { id: friendId } });
    expect(server?.lastFullIndexAt).not.toBeNull();
  });

  it('learns which sort key the server honours', async () => {
    const summary = await indexServer(friendId, { mode: 'incremental' });
    expect(summary.status).toBe('completed');
    expect(summary.mode).toBe('incremental');
    const server = await prisma.server.findUnique({ where: { id: friendId } });
    // mtimeMs is preferred: it moves on file changes, not only on add.
    expect(server?.itemSortField).toBe('mtimeMs');
  });

  it('picks up a newly added book without re-reading the library', async () => {
    friendServer.itemPageRequests = 0;
    friendServer.addItem('friend-lib', {
      id: 'friend-new',
      title: 'Tress of the Emerald Sea',
      authorName: 'Brandon Sanderson',
      duration: 44_000,
      size: 600_000,
      numTracks: 1,
      files: audioFiles('tress', 1),
      updatedAt: LATER,
    });

    const summary = await indexServer(friendId, { mode: 'incremental' });
    expect(summary.status).toBe('completed');
    expect(summary.mode).toBe('incremental');
    expect(summary.itemsIndexed).toBe(1);
    // The whole point: one page, not one page per hundred books.
    expect(friendServer.itemPageRequests).toBe(1);

    const stored = await prisma.indexedItem.findFirst({
      where: { serverId: friendId, absItemId: 'friend-new' },
    });
    expect(stored?.title).toBe('Tress of the Emerald Sea');
  });

  it('does nothing when nothing changed', async () => {
    friendServer.itemPageRequests = 0;
    const summary = await indexServer(friendId, { mode: 'incremental' });
    expect(summary.itemsIndexed).toBe(0);
    expect(summary.itemsRemoved).toBe(0);
    expect(friendServer.itemPageRequests).toBe(1);
  });

  it('cannot see deletions — that is what the full reconcile is for', async () => {
    friendServer.removeItem('friend-lib', 'friend-new');

    const incremental = await indexServer(friendId, { mode: 'incremental' });
    expect(incremental.itemsRemoved).toBe(0);
    // Still present in the index, precisely the limitation being documented.
    expect(
      await prisma.indexedItem.count({ where: { serverId: friendId, absItemId: 'friend-new' } }),
    ).toBe(1);

    const full = await indexServer(friendId, { mode: 'full' });
    expect(full.mode).toBe('full');
    expect(full.itemsRemoved).toBe(1);
    expect(
      await prisma.indexedItem.count({ where: { serverId: friendId, absItemId: 'friend-new' } }),
    ).toBe(0);
  });

  it('escalates to a full crawl when the server ignores the sort key', async () => {
    // A server that honours no sort key at all: early stopping would be unsafe.
    const blind = router.register(
      new MockAbsServer({
        baseUrl: 'https://blind.abs.test',
        apiKeys: ['blind-key'],
        supportedSortKeys: [],
      }),
    );
    blind.addLibrary('blind-lib', 'Audiobooks', [
      { id: 'b-1', title: 'Alpha', authorName: 'Ann Author', updatedAt: 1_700_000_000_000 },
      { id: 'b-2', title: 'Beta', authorName: 'Bob Author', updatedAt: LATER },
    ]);
    const server = await createServer({
      name: 'Blind',
      baseUrl: 'https://blind.abs.test',
      credentials: { kind: 'apiKey', apiKey: 'blind-key' },
    });

    // First run is full regardless; the second is where escalation shows.
    expect((await indexServer(server.id)).mode).toBe('full');
    const summary = await indexServer(server.id, { mode: 'incremental' });

    expect(summary.status).toBe('completed');
    expect(summary.mode).toBe('full');
    expect(summary.escalatedBecause).toMatch(/no usable newest-first sort key/);
    // Both books are indexed, so escalation preserved correctness.
    expect(await prisma.indexedItem.count({ where: { serverId: server.id } })).toBe(2);

    const stored = await prisma.server.findUnique({ where: { id: server.id } });
    expect(stored?.itemSortField).toBeNull();

    await prisma.server.delete({ where: { id: server.id } });
  });

  it('auto mode forces a full reconcile once the last one is stale', async () => {
    const stale = new Date(Date.now() - 48 * 3_600_000);
    await prisma.server.update({ where: { id: friendId }, data: { lastFullIndexAt: stale } });

    const summary = await indexServer(friendId, { mode: 'auto' });
    expect(summary.mode).toBe('full');

    const server = await prisma.server.findUnique({ where: { id: friendId } });
    expect(server!.lastFullIndexAt!.getTime()).toBeGreaterThan(stale.getTime());
  });

  it('auto mode uses incremental while the reconcile is fresh', async () => {
    const summary = await indexServer(friendId, { mode: 'auto' });
    expect(summary.mode).toBe('incremental');
  });
});

describe('comparison', () => {
  it('recognizes the same book under a different title as already owned', async () => {
    const result = await compare({ sourceServerIds: [friendId], groupBy: 'none' });
    const titles = result.groups[0]!.items.map((item) => item.title);
    expect(titles).not.toContain('The Way of Kings: Book One of the Stormlight Archive');
    expect(result.stats.present).toBeGreaterThanOrEqual(1);
  });

  it('reports genuinely missing books', async () => {
    const result = await compare({ sourceServerIds: [friendId], groupBy: 'none' });
    const titles = result.groups[0]!.items.map((item) => item.title);
    expect(titles).toContain('Words of Radiance');
    expect(titles).toContain('Neuromancer');
  });

  it('skips ebook-only items', async () => {
    const result = await compare({ sourceServerIds: [friendId], groupBy: 'none' });
    const titles = result.groups[0]!.items.map((item) => item.title);
    expect(titles).not.toContain('Snow Crash');
    expect(result.stats.skippedNoAudio).toBe(1);
  });

  it('collapses the same missing book from two servers into one row, biggest copy first', async () => {
    const result = await compare({ groupBy: 'none' });
    const radiance = result.groups[0]!.items.find((item) => item.title.startsWith('Words of Radiance'));
    expect(radiance).toBeDefined();
    expect(radiance!.copies).toHaveLength(2);
    // "Other" has the larger file, so it becomes the preferred copy.
    expect(radiance!.bestCopy.serverName).toBe('Other');
    expect(radiance!.copies.map((copy) => copy.serverName).sort()).toEqual(['Friend', 'Other']);
  });

  it('groups by series and by author', async () => {
    const bySeries = await compare({ groupBy: 'series' });
    expect(bySeries.groups.map((group) => group.label)).toContain('The Stormlight Archive');

    const byAuthor = await compare({ groupBy: 'author' });
    expect(byAuthor.groups.map((group) => group.label)).toContain('Brandon Sanderson');
  });

  it('honours the search filter', async () => {
    const result = await compare({ search: 'gibson', groupBy: 'none' });
    expect(result.groups[0]!.items.map((item) => item.title)).toEqual(['Neuromancer']);
  });

  it('refuses to compare against an unindexed target', async () => {
    await prisma.indexedItem.deleteMany({ where: { serverId: mineId } });
    const result = await compare({ groupBy: 'none' });
    expect(result.problem).toMatch(/has not been indexed/);
    // Restore for the remaining tests.
    const summary = await indexServer(mineId);
    expect(summary.status).toBe('completed');
  });
});

describe('transfer', () => {
  beforeEach(() => {
    mineServer.uploads.length = 0;
  });

  it('moves the original audio files from source to target', async () => {
    const outcome = await enqueueSync({
      sourceServerId: friendId,
      sourceItemId: 'friend-2',
      sourceLibraryId: 'friend-lib',
      title: 'Words of Radiance',
      author: 'Brandon Sanderson',
      series: 'The Stormlight Archive',
    });
    expect(outcome.status).toBe('queued');
    if (outcome.status !== 'queued') return;

    const job = await waitForJob(outcome.jobId);
    expect(job.status, `job failed: ${job.error}`).toBe('completed');
    expect(job.error).toBeNull();

    expect(mineServer.uploads).toHaveLength(1);
    const upload = mineServer.uploads[0]!;
    expect(upload.fields).toMatchObject({
      library: 'mine-lib',
      folder: 'mine-lib-folder',
      title: 'Words of Radiance',
      author: 'Brandon Sanderson',
      series: 'The Stormlight Archive',
    });

    // Audio and cover transfer; the .nfo sidecar does not.
    const names = upload.files.map((file) => file.filename);
    expect(names).toEqual(['wor - 01.mp3', 'wor - 02.mp3', 'wor - 03.mp3', 'cover.jpg']);
    expect(upload.files.map((file) => file.field)).toEqual(['0', '1', '2', '3']);

    // Track numbers must survive sanitization, or playback order breaks.
    for (const name of names.slice(0, 3)) {
      expect(name).toMatch(/ - \d\d\.mp3$/);
    }

    // Bytes must arrive intact.
    const expected = new TextDecoder().decode(bytes('AUDIO:wor:1;', 40));
    expect(new TextDecoder().decode(upload.files[0]!.bytes)).toBe(expected);
    expect(upload.files[0]!.contentType).toBe('audio/mpeg');
    expect(upload.files[3]!.contentType).toBe('image/jpeg');

    // Accounting should reflect the audio + cover bytes actually moved.
    const transferred = upload.files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    expect(job.totalBytes).toBe(transferred);
    expect(job.downloadedBytes).toBe(transferred);
    // No id to record: ABS answers an upload with `sendStatus(200)`, so nothing
    // in the response names the item it created. The next index run finds it.
    expect(job.resultItemId).toBeNull();
  });

  it('cleans up the spool directory afterwards', async () => {
    const { readdir } = await import('node:fs/promises');
    // Cleanup happens in the worker's `finally`, just after the job is marked
    // complete, so give it a moment rather than asserting on the same tick.
    const deadline = Date.now() + 5_000;
    let entries: string[] = [];
    for (;;) {
      entries = await readdir(process.env.ABS_SYNC_SPOOL_DIR!).catch(() => []);
      if (entries.length === 0 || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(entries).toEqual([]);
  });

  it('does not queue the same book twice', async () => {
    const again = await enqueueSync({
      sourceServerId: friendId,
      sourceItemId: 'friend-2',
      sourceLibraryId: 'friend-lib',
      title: 'Words of Radiance',
    });
    expect(again.status).toBe('duplicate');
    expect(mineServer.uploads).toHaveLength(0);
  });

  it('marks the book as synced in the next comparison', async () => {
    const result = await compare({ groupBy: 'none' });
    const radiance = result.groups[0]!.items.find((item) => item.title.startsWith('Words of Radiance'));
    // The row still lists the alternate copy, but a completed job is attached.
    if (radiance) {
      expect(radiance.copies.length).toBeGreaterThanOrEqual(1);
    }
    const jobs = await listJobs({ status: ['completed'] });
    expect(jobs.some((job) => job.title === 'Words of Radiance')).toBe(true);
  });

  it('fails cleanly when the item has no audio files to enumerate', async () => {
    const outcome = await enqueueSync({
      sourceServerId: friendId,
      sourceItemId: 'friend-1',
      sourceLibraryId: 'friend-lib',
      title: 'The Way of Kings',
    });
    expect(outcome.status).toBe('queued');
    if (outcome.status !== 'queued') return;

    const job = await waitForJob(outcome.jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/did not report any audio files/);
    // Nothing should have been uploaded from a failed transfer.
    expect(mineServer.uploads).toHaveLength(0);
  });

  /**
   * A server whose `media.audioFiles` lists every file twice, the second time
   * under an ino `libraryFiles` has never heard of.
   *
   * This is not hypothetical: a remount changed the inode numbers on a real
   * 2.35.1 server and 88% of its library ended up in this state. Every sync from
   * it failed with a 404, because those inos are not resolvable by any file
   * endpoint.
   */
  async function remountedSource(label: string, items: MockItemInput[]) {
    const baseUrl = `https://${label}.abs.test`;
    const remounted = router.register(new MockAbsServer({ baseUrl, apiKeys: ['remount-key'] }));
    remounted.addLibrary('remount-lib', 'Audiobooks', items);
    const server = await createServer({
      name: `Remounted ${label}`,
      baseUrl,
      credentials: { kind: 'apiKey', apiKey: 'remount-key' },
    });
    return { remounted, server };
  }

  it('transfers only the real files when the source reports stale duplicates', async () => {
    const files = audioFiles('dup', 2);
    const { server } = await remountedSource('dup', [
      {
        id: 'dup-1',
        title: 'Fight and Flight',
        authorName: 'Scott Meyer',
        numTracks: 2,
        files,
        // The same two files again, under inos that no longer exist on disk.
        phantomAudioFiles: files.map((file, index) => ({
          ino: `56294995351999${index}`,
          filename: file.filename,
          size: file.content.byteLength,
        })),
      },
    ]);

    const outcome = await enqueueSync({
      sourceServerId: server.id,
      sourceItemId: 'dup-1',
      sourceLibraryId: 'remount-lib',
      title: 'Fight and Flight',
      author: 'Scott Meyer',
    });
    expect(outcome.status).toBe('queued');
    if (outcome.status !== 'queued') return;

    const job = await waitForJob(outcome.jobId);
    expect(job.status, `job failed: ${job.error}`).toBe('completed');
    expect(job.error).toBeNull();

    // Each file exactly once, not twice and not zero times.
    expect(mineServer.uploads).toHaveLength(1);
    expect(mineServer.uploads[0]!.files.map((file) => file.filename)).toEqual([
      'dup - 01.mp3',
      'dup - 02.mp3',
      'cover.jpg',
    ]);

    await prisma.server.delete({ where: { id: server.id } });
  });

  it('refuses the transfer when audio exists only in media.* and cannot be fetched', async () => {
    const { server } = await remountedSource('ghost', [
      {
        id: 'ghost-1',
        title: 'Spell or High Water',
        authorName: 'Scott Meyer',
        numTracks: 2,
        files: audioFiles('ghost', 1),
        // A second chapter with no downloadable file behind it.
        phantomAudioFiles: [{ ino: 'ghost-ino', filename: 'ghost - 02.mp3', size: 40 }],
      },
    ]);

    const outcome = await enqueueSync({
      sourceServerId: server.id,
      sourceItemId: 'ghost-1',
      sourceLibraryId: 'remount-lib',
      title: 'Spell or High Water',
    });
    expect(outcome.status).toBe('queued');
    if (outcome.status !== 'queued') return;

    const job = await waitForJob(outcome.jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/cannot be downloaded/);
    // Better to fail than to upload an audiobook missing a chapter.
    expect(mineServer.uploads).toHaveLength(0);

    await prisma.server.delete({ where: { id: server.id } });
  });

  it('reuses already-downloaded files instead of fetching them again', async () => {
    // A transfer that fails at the upload step has perfectly good audio on disk.
    // The retry must upload those bytes, not pull the whole book down again.
    const flaky = router.register(
      new MockAbsServer({ baseUrl: 'https://reuse.abs.test', apiKeys: ['reuse-key'] }),
    );
    flaky.addLibrary('reuse-lib', 'Audiobooks', [
      { id: 'reuse-1', title: 'Reused Book', authorName: 'Ann Author', numTracks: 3, files: audioFiles('reuse', 3) },
    ]);
    const source = await createServer({
      name: 'Reuse source',
      baseUrl: 'https://reuse.abs.test',
      credentials: { kind: 'apiKey', apiKey: 'reuse-key' },
    });

    // Make the first upload attempt fail so the job is retried.
    let uploadAttempts = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('mine.abs.test/api/upload')) {
        uploadAttempts++;
        if (uploadAttempts === 1) {
          return new Response(JSON.stringify({ error: 'flaky' }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      const outcome = await enqueueSync({
        sourceServerId: source.id,
        sourceItemId: 'reuse-1',
        sourceLibraryId: 'reuse-lib',
        title: 'Reused Book',
      });
      expect(outcome.status).toBe('queued');
      if (outcome.status !== 'queued') return;

      const job = await waitForJob(outcome.jobId);
      expect(job.status, `job failed: ${job.error}`).toBe('completed');
      // Two upload attempts: the 502 and the retry that succeeded.
      expect(uploadAttempts).toBe(2);

      // The crux: each source file was fetched exactly once across both attempts.
      const fileFetches = flaky.requestLog.filter((entry) => entry.includes('/file/'));
      expect(fileFetches).toHaveLength(4); // 3 audio + 1 cover
    } finally {
      globalThis.fetch = realFetch;
      await prisma.syncJob.deleteMany({ where: { sourceServerId: source.id } });
      await prisma.server.delete({ where: { id: source.id } });
    }
  });

  it('re-downloads a file whose spooled copy is the wrong size', async () => {
    const { readdir, writeFile } = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const spoolRoot = process.env.ABS_SYNC_SPOOL_DIR!;

    const server = router.register(
      new MockAbsServer({ baseUrl: 'https://partial.abs.test', apiKeys: ['partial-key'] }),
    );
    server.addLibrary('partial-lib', 'Audiobooks', [
      { id: 'partial-1', title: 'Partial Book', authorName: 'Ann Author', numTracks: 1, files: audioFiles('partial', 1) },
    ]);
    const source = await createServer({
      name: 'Partial source',
      baseUrl: 'https://partial.abs.test',
      credentials: { kind: 'apiKey', apiKey: 'partial-key' },
    });

    try {
      const outcome = await enqueueSync({
        sourceServerId: source.id,
        sourceItemId: 'partial-1',
        sourceLibraryId: 'partial-lib',
        title: 'Partial Book',
      });
      if (outcome.status !== 'queued') throw new Error('not queued');
      const first = await waitForJob(outcome.jobId);
      expect(first.status, `job failed: ${first.error}`).toBe('completed');

      // Plant a truncated file where the retry will look for it.
      const jobDir = nodePath.join(spoolRoot, outcome.jobId);
      await prisma.syncJob.update({
        where: { id: outcome.jobId },
        data: { status: 'queued', phase: 'pending', attempts: 0, finishedAt: null, error: null },
      });
      const { mkdir } = await import('node:fs/promises');
      await mkdir(jobDir, { recursive: true });
      await writeFile(nodePath.join(jobDir, 'partial-ino-1-partial - 01.mp3'), 'TRUNCATED');

      mineServer.uploads.length = 0;
      getWorker().wake();
      const second = await waitForJob(outcome.jobId);
      expect(second.status, `retry failed: ${second.error}`).toBe('completed');

      // The truncated stand-in must not have been uploaded.
      const uploaded = mineServer.uploads.at(-1)!.files.find((f) => f.filename.endsWith('01.mp3'))!;
      expect(new TextDecoder().decode(uploaded.bytes)).not.toBe('TRUNCATED');
      expect(uploaded.bytes.byteLength).toBeGreaterThan('TRUNCATED'.length);

      // Cleanup runs in the worker's `finally`, just after the job is marked
      // complete, so poll rather than asserting on the same tick.
      const deadline = Date.now() + 5_000;
      let present = true;
      while (Date.now() < deadline) {
        present = (await readdir(spoolRoot).catch((): string[] => [])).includes(outcome.jobId);
        if (!present) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // A successful transfer keeps nothing: retention is only for retryable work.
      expect(present).toBe(false);
    } finally {
      await prisma.syncJob.deleteMany({ where: { sourceServerId: source.id } });
      await prisma.server.delete({ where: { id: source.id } });
    }
  });

  it('keeps the downloaded audio when a transfer fails permanently', async () => {
    // The guarantee: bytes are only discarded once they can no longer be useful.
    // A permanently failed transfer is exactly the case where someone fixes the
    // cause and hits Retry, so its download must still be there.
    const { readdir } = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const spoolRoot = process.env.ABS_SYNC_SPOOL_DIR!;

    const proxied = router.register(
      new MockAbsServer({
        baseUrl: 'https://keeps.abs.test',
        apiKeys: ['keeps-key'],
        proxyRejectsUploads: true,
      }),
    );
    proxied.addLibrary('keeps-lib', 'Audiobooks', []);
    const targetServer = await createServer({
      name: 'Keeps target',
      baseUrl: 'https://keeps.abs.test',
      credentials: { kind: 'apiKey', apiKey: 'keeps-key' },
    });
    await setTargetServer(targetServer.id);

    try {
      const outcome = await enqueueSync({
        sourceServerId: friendId,
        sourceItemId: 'friend-2',
        sourceLibraryId: 'friend-lib',
        title: 'Words of Radiance',
      });
      if (outcome.status !== 'queued') throw new Error(`not queued: ${JSON.stringify(outcome)}`);

      const job = await waitForJob(outcome.jobId);
      expect(job.status).toBe('failed');

      // The audio survived, and the job still points at it.
      const spooled = await readdir(nodePath.join(spoolRoot, outcome.jobId));
      expect(spooled.length).toBeGreaterThan(0);
      expect(job.spoolPath).toBe(nodePath.join(spoolRoot, outcome.jobId));
    } finally {
      await setTargetServer(mineId);
      await prisma.syncJob.deleteMany({ where: { targetServerId: targetServer.id } });
      await prisma.server.delete({ where: { id: targetServer.id } });
    }
  });

  it('discards the download when a transfer is canceled', async () => {
    const { readdir } = await import('node:fs/promises');
    const outcome = await enqueueSync({
      sourceServerId: otherId,
      sourceItemId: 'other-2',
      sourceLibraryId: 'other-lib',
      title: 'Oathbringer',
    });
    if (outcome.status !== 'queued') throw new Error('not queued');

    await cancelJob(outcome.jobId);
    const job = await waitForJob(outcome.jobId);
    expect(job.status).toBe('canceled');
    expect(job.spoolPath).toBeNull();

    const deadline = Date.now() + 5_000;
    let present = true;
    while (Date.now() < deadline) {
      present = (await readdir(process.env.ABS_SYNC_SPOOL_DIR!).catch((): string[] => [])).includes(
        outcome.jobId,
      );
      if (!present) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(present).toBe(false);
  });

  it('does not retry an upload the target refused as too large', async () => {
    // A reverse proxy 413 is deterministic. Retrying re-downloads the whole
    // audiobook to fail identically, so the job must stop on the first attempt.
    const proxied = router.register(
      new MockAbsServer({
        baseUrl: 'https://proxied.abs.test',
        apiKeys: ['proxied-key'],
        proxyRejectsUploads: true,
      }),
    );
    proxied.addLibrary('proxied-lib', 'Audiobooks', []);
    const targetServer = await createServer({
      name: 'Proxied target',
      baseUrl: 'https://proxied.abs.test',
      credentials: { kind: 'apiKey', apiKey: 'proxied-key' },
    });
    await setTargetServer(targetServer.id);

    try {
      const outcome = await enqueueSync({
        sourceServerId: friendId,
        sourceItemId: 'friend-3',
        sourceLibraryId: 'friend-lib',
        title: 'Neuromancer',
      });
      expect(outcome.status).toBe('queued');
      if (outcome.status !== 'queued') return;

      const job = await waitForJob(outcome.jobId);
      expect(job.status).toBe('failed');
      // Stopped after one attempt rather than burning all three.
      expect(job.attempts).toBe(1);
      expect(job.error).toMatch(/client_max_body_size/);
      expect(job.error).toMatch(/nginx/);
    } finally {
      await setTargetServer(mineId);
      await prisma.syncJob.deleteMany({ where: { targetServerId: targetServer.id } });
      await prisma.server.delete({ where: { id: targetServer.id } });
    }
  });

  it('refuses to pull from a server without download permission', async () => {
    await prisma.server.update({ where: { id: otherId }, data: { canDownload: false } });
    const outcome = await enqueueSync({
      sourceServerId: otherId,
      sourceItemId: 'other-2',
      sourceLibraryId: 'other-lib',
      title: 'Oathbringer',
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.reason).toMatch(/download permission/);
    }
    await prisma.server.update({ where: { id: otherId }, data: { canDownload: true } });
  });
});

describe('series watches', () => {
  beforeEach(() => {
    mineServer.uploads.length = 0;
  });

  it('suggests series the target owns nothing from', async () => {
    const suggestions = await suggestSeriesToWatch();
    // Stormlight is partially owned, so it should not be suggested.
    expect(suggestions.map((entry) => entry.normSeries)).not.toContain('stormlight archive');
  });

  it('queues and transfers the rest of a watched series', async () => {
    const watch = await createWatch({ seriesName: 'The Stormlight Archive' });
    expect(watch.autoEnqueue).toBe(true);

    const evaluation = await evaluateWatch(watch.id);
    expect(evaluation.error).toBeUndefined();
    // Oathbringer is the only unowned, unqueued book left in the series.
    expect(evaluation.enqueued).toBe(1);

    const queued = await prisma.syncJob.findFirst({
      where: { watchId: watch.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(queued?.title).toBe('Oathbringer');
    expect(queued?.origin).toBe('watch');

    const job = await waitForJob(queued!.id);
    expect(job.status, `watch transfer failed: ${job.error}`).toBe('completed');
    expect(mineServer.uploads).toHaveLength(1);
    expect(mineServer.uploads[0]!.fields.title).toBe('Oathbringer');
    expect(mineServer.uploads[0]!.files.map((file) => file.filename)).toEqual([
      'oath - 01.mp3',
      'oath - 02.mp3',
      'cover.jpg',
    ]);
  });

  it('does not re-queue on a second evaluation', async () => {
    const watch = await prisma.seriesWatch.findFirst({ where: { normSeries: 'stormlight archive' } });
    const evaluation = await evaluateWatch(watch!.id);
    expect(evaluation.enqueued).toBe(0);
  });

  it('refuses a duplicate watch for the same series and library', async () => {
    await expect(createWatch({ seriesName: 'Stormlight Archive' })).rejects.toThrow(
      /already being watched/,
    );
  });

  it('skips evaluation when the target has no index, rather than queueing everything', async () => {
    const watch = await createWatch({ seriesName: 'A Brand New Series' });
    const saved = await prisma.indexedItem.findMany({ where: { serverId: mineId } });
    await prisma.indexedItem.deleteMany({ where: { serverId: mineId } });

    const evaluation = await evaluateWatch(watch.id);
    expect(evaluation.error).toMatch(/no index/);
    expect(evaluation.enqueued).toBe(0);

    // Restore the index so later assertions are unaffected.
    await prisma.indexedItem.createMany({ data: saved });
  });
});

describe('target server changes', () => {
  it('moves the target flag exclusively', async () => {
    await prisma.server.update({ where: { id: friendId }, data: { canUpload: true } });
    await setTargetServer(friendId);

    const targets = await prisma.server.findMany({ where: { isTarget: true } });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe(friendId);

    await setTargetServer(mineId);
  });

  it('will not target a server that cannot upload', async () => {
    await prisma.server.update({ where: { id: otherId }, data: { canUpload: false } });
    await expect(setTargetServer(otherId)).rejects.toThrow(/cannot receive books/);
  });
});

/**
 * Runs last on purpose. `clearFinishedJobs` is global — it removes every finished
 * job row, which is exactly the state earlier tests depend on to assert that a
 * book is not queued twice.
 */
describe('re-requesting a stopped transfer', () => {
  it('revives the existing row instead of adding another one for the same book', async () => {
    // Cancelling a transfer and asking for the same book again used to leave two
    // rows on the Transfers page — then three, then four — with no way to tell
    // which one to retry or which held the download.
    const library = await prisma.library.findFirstOrThrow({ where: { serverId: mineId } });
    const stopped = await prisma.syncJob.create({
      data: {
        sourceServerId: friendId,
        sourceItemId: 'friend-revive',
        sourceLibraryId: 'friend-lib',
        targetServerId: mineId,
        targetLibraryId: library.id,
        targetFolderId: 'mine-lib-folder',
        title: 'Revived Book',
        normTitle: 'revived book',
        status: 'canceled',
        attempts: 3,
        error: 'Paused pending review',
        spoolPath: '/spool/friend-revive',
        finishedAt: new Date(),
      },
    });

    const outcome = await enqueueSync({
      sourceServerId: friendId,
      sourceItemId: 'friend-revive',
      sourceLibraryId: 'friend-lib',
      title: 'Revived Book',
    });

    expect(outcome).toMatchObject({ status: 'queued', jobId: stopped.id });
    const rows = await prisma.syncJob.findMany({ where: { sourceItemId: 'friend-revive' } });
    expect(rows).toHaveLength(1);
    // The retained download comes with it, so nothing is fetched twice.
    expect(rows[0]!.spoolPath).not.toBeNull();
    expect(rows[0]!.error).toBeNull();

    await cancelJob(stopped.id);
  });
});

describe('clearing finished transfers', () => {
  it('discards retained downloads and reports the disk freed', async () => {
    const { mkdir, readdir, writeFile } = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const spoolRoot = process.env.ABS_SYNC_SPOOL_DIR!;

    // A failed transfer holding a download, as one does after e.g. a proxy 413.
    const job = await prisma.syncJob.create({
      data: {
        sourceServerId: friendId,
        sourceItemId: 'friend-3',
        sourceLibraryId: 'friend-lib',
        targetServerId: mineId,
        targetLibraryId: (await prisma.library.findFirstOrThrow({ where: { serverId: mineId } })).id,
        targetFolderId: 'mine-lib-folder',
        title: 'Retained Book',
        status: 'failed',
        finishedAt: new Date(),
        error: 'upload rejected',
      },
    });
    const dir = nodePath.join(spoolRoot, job.id);
    await mkdir(dir, { recursive: true });
    await writeFile(nodePath.join(dir, 'retained.mp3'), 'x'.repeat(4096));

    const result = await clearFinishedJobs();
    expect(result.count).toBeGreaterThan(0);
    expect(result.freedBytes).toBeGreaterThanOrEqual(4096);
    expect(await readdir(spoolRoot).catch((): string[] => [])).not.toContain(job.id);
    expect(await prisma.syncJob.findUnique({ where: { id: job.id } })).toBeNull();
  });
});
