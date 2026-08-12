import { describe, expect, it, vi } from 'vitest';
import { AbsClient } from './client';
import { AbsAuthError, AbsHttpError } from './errors';
import { MockAbsServer, type MockItemInput, type MockServerOptions } from './mock-server';

const LIBRARY_ITEMS: MockItemInput[] = [
  {
    id: 'item-1',
    title: 'The Way of Kings',
    authorName: 'Brandon Sanderson',
    narratorName: 'Michael Kramer, Kate Reading',
    seriesName: 'The Stormlight Archive #1',
    asin: 'B0036KWX0Y',
    duration: 160000,
    size: 1_200_000,
    numTracks: 3,
  },
  {
    id: 'item-2',
    title: 'Words of Radiance',
    authorName: 'Brandon Sanderson',
    seriesName: 'The Stormlight Archive #2',
    duration: 170000,
    size: 1_300_000,
  },
  { id: 'item-3', title: 'Project Hail Mary', authorName: 'Andy Weir', duration: 58000 },
  { id: 'podcast-1', title: 'Some Podcast', mediaType: 'podcast' },
  { id: 'missing-1', title: 'Vanished Book', isMissing: true },
];

function makeServer(options: MockServerOptions = {}) {
  const server = new MockAbsServer({ apiKeys: ['test-key'], ...options });
  server.addLibrary('lib-1', 'Audiobooks', LIBRARY_ITEMS);
  return server;
}

function clientFor(server: MockAbsServer, overrides: Partial<ConstructorParameters<typeof AbsClient>[0]> = {}) {
  return new AbsClient({
    baseUrl: server.baseUrl,
    auth: { kind: 'apiKey', apiKey: 'test-key' },
    fetchImpl: server.fetch,
    serverKey: 'srv-1',
    maxRetries: 3,
    ...overrides,
  });
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Emit in small chunks so streaming behaviour is actually exercised.
      for (let offset = 0; offset < bytes.byteLength; offset += 8) {
        controller.enqueue(bytes.subarray(offset, Math.min(offset + 8, bytes.byteLength)));
      }
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe('authentication', () => {
  it('verifies an API key and reports permissions', async () => {
    const client = clientFor(makeServer());
    const identity = await client.verify();
    expect(identity.user.username).toBe('tester');
    expect(identity.serverVersion).toBe('2.26.0');
    expect(identity.isAdmin).toBe(true);
    expect(identity.canDownload).toBe(true);
    expect(identity.canUpload).toBe(true);
  });

  it('rejects a bad API key with an auth error', async () => {
    const server = makeServer();
    const client = clientFor(server, { auth: { kind: 'apiKey', apiKey: 'wrong' } });
    await expect(client.verify()).rejects.toBeInstanceOf(AbsAuthError);
  });

  it('logs in with username/password and reports the token', async () => {
    const server = makeServer({
      apiKeys: [],
      users: [{ username: 'conrad', password: 'hunter2', token: 'session-token', type: 'admin' }],
    });
    const onToken = vi.fn();
    const client = new AbsClient({
      baseUrl: server.baseUrl,
      auth: { kind: 'password', username: 'conrad', password: 'hunter2' },
      fetchImpl: server.fetch,
      onToken,
    });
    const identity = await client.verify();
    expect(identity.user.username).toBe('tester');
    expect(onToken).toHaveBeenCalledWith('session-token');
    expect(client.currentToken).toBe('session-token');
  });

  it('surfaces bad credentials as an auth error', async () => {
    const server = makeServer({
      apiKeys: [],
      users: [{ username: 'conrad', password: 'hunter2', token: 'session-token' }],
    });
    const client = new AbsClient({
      baseUrl: server.baseUrl,
      auth: { kind: 'password', username: 'conrad', password: 'wrong' },
      fetchImpl: server.fetch,
    });
    await expect(client.verify()).rejects.toBeInstanceOf(AbsAuthError);
  });

  it('reports missing download/upload permission for a limited user', async () => {
    const server = makeServer({ userType: 'user', permissions: { download: false, upload: false } });
    const identity = await clientFor(server).verify();
    expect(identity.isAdmin).toBe(false);
    expect(identity.canDownload).toBe(false);
    expect(identity.canUpload).toBe(false);
  });

  it('normalizes a bare hostname to https', () => {
    const client = new AbsClient({ baseUrl: 'abs.example.com/', auth: { kind: 'apiKey', apiKey: 'k' } });
    expect(client.baseUrl).toBe('https://abs.example.com');
  });
});

describe('library indexing', () => {
  it('lists libraries with their upload folders', async () => {
    const libraries = await clientFor(makeServer()).getLibraries();
    expect(libraries).toHaveLength(1);
    expect(libraries[0]!.folders?.[0]?.id).toBe('lib-1-folder');
  });

  it('pages through a library and maps records, skipping podcasts and missing items', async () => {
    const client = clientFor(makeServer());
    const records = [];
    for await (const record of client.iterateBooks('lib-1', { pageSize: 2 })) {
      records.push(record);
    }
    // The client asks for a title sort, so results come back alphabetically.
    expect(records.map((r) => r.title)).toEqual([
      'Project Hail Mary',
      'The Way of Kings',
      'Words of Radiance',
    ]);
    const kings = records.find((r) => r.title === 'The Way of Kings')!;
    expect(kings.key).toBe('srv-1:item-1');
    expect(kings.serverId).toBe('srv-1');
  });

  it('parses the packed minified seriesName into name and sequence', async () => {
    const client = clientFor(makeServer());
    const records = [];
    for await (const record of client.iterateBooks('lib-1')) records.push(record);
    const kings = records.find((r) => r.title === 'The Way of Kings')!;
    expect(kings.series).toEqual([{ name: 'The Stormlight Archive', sequence: '1' }]);
    expect(kings.authors).toEqual(['Brandon Sanderson']);
    expect(kings.narrators).toEqual(['Michael Kramer', 'Kate Reading']);
    expect(kings.hasAudio).toBe(true);
  });

  it('backfills identifiers missing from minified payloads when enrich is set', async () => {
    const client = clientFor(makeServer());
    const plain = [];
    for await (const record of client.iterateBooks('lib-1')) plain.push(record);
    // Minified responses in the mock omit ASIN, mirroring real ABS behaviour.
    expect(plain.find((r) => r.title === 'The Way of Kings')!.asin).toBeNull();

    const enriched = [];
    for await (const record of client.iterateBooks('lib-1', { enrich: true })) enriched.push(record);
    const kings = enriched.find((r) => r.title === 'The Way of Kings')!;
    expect(kings.asin).toBe('B0036KWX0Y');
    expect(kings.key).toBe('srv-1:item-1');
  });

  it('reports progress while paging', async () => {
    const onProgress = vi.fn();
    const client = clientFor(makeServer());
    for await (const _ of client.iterateBooks('lib-1', { pageSize: 2, onProgress })) {
      // drain
    }
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress.mock.calls.at(-1)?.[1]).toBe(5);
  });

  it('stops paging when the signal is aborted', async () => {
    const client = clientFor(makeServer());
    const controller = new AbortController();
    const records = [];
    for await (const record of client.iterateBooks('lib-1', { pageSize: 1, signal: controller.signal })) {
      records.push(record);
      controller.abort();
    }
    expect(records).toHaveLength(1);
  });

  it('groups series', async () => {
    const client = clientFor(makeServer());
    const series = [];
    for await (const entry of client.iterateSeries('lib-1')) series.push(entry);
    expect(series.map((s) => s.name)).toEqual(['The Stormlight Archive']);
  });
});

describe('fetchBooksModifiedSince', () => {
  const T0 = 1_700_000_000_000;
  const DAY = 86_400_000;

  function timelineServer(options: MockServerOptions = {}) {
    const server = new MockAbsServer({ apiKeys: ['test-key'], ...options });
    server.addLibrary(
      'lib-1',
      'Audiobooks',
      // Deliberately out of chronological order in insertion order, so a mock
      // that ignores the sort key produces an unordered page.
      [
        { id: 'old-1', title: 'Old One', authorName: 'A Writer', updatedAt: T0 },
        { id: 'new-1', title: 'New One', authorName: 'B Writer', updatedAt: T0 + 5 * DAY },
        { id: 'old-2', title: 'Old Two', authorName: 'C Writer', updatedAt: T0 + DAY },
        { id: 'new-2', title: 'New Two', authorName: 'D Writer', updatedAt: T0 + 6 * DAY },
        { id: 'old-3', title: 'Old Three', authorName: 'E Writer', updatedAt: T0 + 2 * DAY },
      ],
    );
    return server;
  }

  it('returns only items at or after `since` and stops early', async () => {
    const result = await clientFor(timelineServer()).fetchBooksModifiedSince('lib-1', {
      since: T0 + 4 * DAY,
      sortField: 'updatedAt',
      pageSize: 2,
    });

    expect(result.ordered).toBe(true);
    expect(result.records.map((r) => r.title)).toEqual(['New Two', 'New One']);
    expect(result.reachedOlder).toBe(true);
    expect(result.pagesFetched).toBeLessThanOrEqual(2);
  });

  it('reports every item when `since` predates the library', async () => {
    const result = await clientFor(timelineServer()).fetchBooksModifiedSince('lib-1', {
      since: 0,
      sortField: 'updatedAt',
      pageSize: 100,
    });
    expect(result.records).toHaveLength(5);
    expect(result.exhausted).toBe(true);
    expect(result.reachedOlder).toBe(false);
  });

  it('returns nothing when nothing has changed', async () => {
    const result = await clientFor(timelineServer()).fetchBooksModifiedSince('lib-1', {
      since: T0 + 100 * DAY,
      sortField: 'updatedAt',
      pageSize: 2,
    });
    expect(result.records).toEqual([]);
    expect(result.ordered).toBe(true);
    expect(result.reachedOlder).toBe(true);
  });

  it('detects a server that ignores the sort key instead of trusting it', async () => {
    const server = timelineServer({ supportedSortKeys: [] });
    const result = await clientFor(server).fetchBooksModifiedSince('lib-1', {
      since: T0 + 4 * DAY,
      sortField: 'updatedAt',
      pageSize: 10,
    });

    expect(result.ordered).toBe(false);
    // Records from an unordered response must not be presented as complete.
    expect(result.records).toEqual([]);
  });

  it('validates the field it sorted by, not a preferred one', async () => {
    // Reproduces real Audiobookshelf behaviour: sorting by mtimeMs works, while
    // updatedAt is populated on every item but in no useful order. Validating
    // updatedAt here would reject a perfectly good mtimeMs-sorted response.
    const server = new MockAbsServer({ apiKeys: ['test-key'], supportedSortKeys: ['mtimeMs'] });
    server.addLibrary('lib-1', 'Audiobooks', [
      { id: 'a', title: 'Alpha', authorName: 'A Writer', mtimeMs: T0 + DAY, updatedAt: T0 + 9 * DAY },
      { id: 'b', title: 'Beta', authorName: 'B Writer', mtimeMs: T0 + 5 * DAY, updatedAt: T0 + 2 * DAY },
      { id: 'c', title: 'Gamma', authorName: 'C Writer', mtimeMs: T0 + 3 * DAY, updatedAt: T0 + 7 * DAY },
    ]);

    const result = await clientFor(server).fetchBooksModifiedSince('lib-1', {
      since: T0 + 2 * DAY,
      sortField: 'mtimeMs',
      pageSize: 10,
    });

    expect(result.ordered).toBe(true);
    expect(result.records.map((r) => r.title)).toEqual(['Beta', 'Gamma']);
    expect(result.reachedOlder).toBe(true);
  });

  it('rejects a sort key the server does not honour, so the caller can try another', async () => {
    const server = new MockAbsServer({ apiKeys: ['test-key'], supportedSortKeys: ['mtimeMs'] });
    server.addLibrary('lib-1', 'Audiobooks', [
      { id: 'a', title: 'Alpha', authorName: 'A Writer', mtimeMs: T0 + DAY, addedAt: T0 + 9 * DAY },
      { id: 'b', title: 'Beta', authorName: 'B Writer', mtimeMs: T0 + 5 * DAY, addedAt: T0 + 2 * DAY },
      { id: 'c', title: 'Gamma', authorName: 'C Writer', mtimeMs: T0 + 3 * DAY, addedAt: T0 + 7 * DAY },
    ]);
    const result = await clientFor(server).fetchBooksModifiedSince('lib-1', {
      since: T0,
      sortField: 'addedAt',
      pageSize: 10,
    });
    expect(result.ordered).toBe(false);
  });

  it('gives up rather than crawling forever when maxPages is hit', async () => {
    const result = await clientFor(timelineServer()).fetchBooksModifiedSince('lib-1', {
      since: 0,
      sortField: 'updatedAt',
      pageSize: 1,
      maxPages: 2,
    });
    expect(result.pagesFetched).toBe(2);
    expect(result.reachedOlder).toBe(false);
    expect(result.exhausted).toBe(false);
  });

  it('exposes candidate sort keys with mtimeMs preferred', () => {
    expect([...AbsClient.MODIFIED_SORT_CANDIDATES]).toEqual(['mtimeMs', 'addedAt', 'updatedAt']);
  });
});

describe('ambiguous comma-joined names', () => {
  function serverWithAuthor(authorName: string, narratorName = '') {
    const server = new MockAbsServer({ apiKeys: ['test-key'] });
    server.addLibrary('lib-1', 'Audiobooks', [
      { id: 'item-1', title: 'A Book', authorName, narratorName },
    ]);
    return server;
  }

  async function firstRecord(server: MockAbsServer) {
    for await (const record of clientFor(server).iterateBooks('lib-1')) return record;
    throw new Error('no records');
  }

  it('keeps "Last, First" as one person', async () => {
    const record = await firstRecord(serverWithAuthor('Sanderson, Brandon'));
    expect(record.authors).toEqual(['Sanderson, Brandon']);
  });

  it('splits two full names', async () => {
    const record = await firstRecord(serverWithAuthor('Brandon Sanderson, Andy Weir'));
    expect(record.authors).toEqual(['Brandon Sanderson', 'Andy Weir']);
  });

  it('splits narrator pairs', async () => {
    const record = await firstRecord(serverWithAuthor('', 'Michael Kramer, Kate Reading'));
    expect(record.narrators).toEqual(['Michael Kramer', 'Kate Reading']);
  });

  it('handles a single name with no comma', async () => {
    const record = await firstRecord(serverWithAuthor('J.R.R. Tolkien'));
    expect(record.authors).toEqual(['J.R.R. Tolkien']);
  });
});

describe('retries', () => {
  it('retries transient 5xx responses', async () => {
    const server = makeServer({ flakyPath: { path: '/api/libraries', failures: 2 } });
    const client = clientFor(server);
    const libraries = await client.getLibraries();
    expect(libraries).toHaveLength(1);
    const attempts = server.requestLog.filter((entry) => entry === 'GET /api/libraries');
    expect(attempts).toHaveLength(3);
  });

  it('gives up after maxRetries and surfaces the HTTP error', async () => {
    const server = makeServer({ flakyPath: { path: '/api/libraries', failures: 99 } });
    const client = clientFor(server, { maxRetries: 1 });
    await expect(client.getLibraries()).rejects.toBeInstanceOf(AbsHttpError);
  });
});

describe('downloads', () => {
  it('streams an item download', async () => {
    const content = new TextEncoder().encode('THE-AUDIO-BYTES');
    const server = new MockAbsServer({ apiKeys: ['test-key'] });
    server.addLibrary('lib-1', 'Audiobooks', [{ id: 'item-1', title: 'Dune', content }]);

    const handle = await clientFor(server).openDownload('item-1', { libraryId: 'lib-1' });
    expect(handle.contentLength).toBe(content.byteLength);
    expect(handle.filename).toBe('Dune.zip');
    expect(new TextDecoder().decode(await drain(handle.stream))).toBe('THE-AUDIO-BYTES');
  });

  it('falls back to the library-scoped download URL when the item URL 404s', async () => {
    const server = new MockAbsServer({ apiKeys: ['test-key'], downloadStyle: 'library' });
    server.addLibrary('lib-1', 'Audiobooks', [{ id: 'item-1', title: 'Dune' }]);
    const client = clientFor(server);

    const handle = await client.openDownload('item-1', { libraryId: 'lib-1' });
    expect(handle.endpoint).toBe('/api/libraries/lib-1/items/item-1/download');
    await handle.stream.cancel();

    // The working shape is remembered, so the second call skips the 404 probe.
    server.requestLog.length = 0;
    const second = await client.openDownload('item-1', { libraryId: 'lib-1' });
    await second.stream.cancel();
    expect(server.requestLog).toEqual(['GET /api/libraries/lib-1/items/item-1/download']);
  });

  it('raises an auth error when the account cannot download', async () => {
    const server = makeServer({ permissions: { download: false } });
    await expect(clientFor(server).openDownload('item-1', { libraryId: 'lib-1' })).rejects.toBeInstanceOf(
      AbsAuthError,
    );
  });
});

describe('per-file transfer', () => {
  const bytesFor = (text: string) => new TextEncoder().encode(text);

  function fileServer(style?: 'both' | 'download') {
    const server = new MockAbsServer({
      apiKeys: ['test-key'],
      ...(style ? { fileEndpointStyle: style } : {}),
    });
    server.addLibrary('lib-1', 'Audiobooks', [
      {
        id: 'item-1',
        title: 'Dune',
        authorName: 'Frank Herbert',
        numTracks: 2,
        files: [
          { ino: 'ino-1', filename: 'Dune - 01.mp3', fileType: 'audio', content: bytesFor('AUDIO-ONE') },
          { ino: 'ino-2', filename: 'Dune - 02.mp3', fileType: 'audio', content: bytesFor('AUDIO-TWO') },
          { ino: 'ino-3', filename: 'cover.jpg', fileType: 'image', content: bytesFor('COVER') },
          { ino: 'ino-4', filename: 'desc.nfo', fileType: 'metadata', content: bytesFor('NFO') },
        ],
      },
    ]);
    return server;
  }

  it('enumerates an item’s files with kinds and sizes', async () => {
    const files = await clientFor(fileServer()).listItemFiles('item-1');
    expect(files.map((f) => [f.filename, f.kind, f.size])).toEqual([
      ['Dune - 01.mp3', 'audio', 9],
      ['Dune - 02.mp3', 'audio', 9],
      ['cover.jpg', 'image', 5],
      ['desc.nfo', 'other', 3],
    ]);
  });

  it('downloads an individual file by ino', async () => {
    const handle = await clientFor(fileServer()).openFileDownload('item-1', 'ino-2');
    expect(handle.filename).toBe('Dune - 02.mp3');
    expect(handle.contentLength).toBe(9);
    expect(new TextDecoder().decode(await drain(handle.stream))).toBe('AUDIO-TWO');
  });

  it('falls back between the bare and /download file endpoints', async () => {
    const handle = await clientFor(fileServer('download')).openFileDownload('item-1', 'ino-1');
    expect(handle.endpoint).toBe('/api/items/item-1/file/ino-1/download');
    expect(new TextDecoder().decode(await drain(handle.stream))).toBe('AUDIO-ONE');
  });

  it('reports a clear error for an unknown file', async () => {
    await expect(clientFor(fileServer()).openFileDownload('item-1', 'nope')).rejects.toBeInstanceOf(
      AbsHttpError,
    );
  });

  /**
   * The real failure this guards against: a server whose `media.audioFiles`
   * lists every file twice, once under a stale ino. Those inos 404 on the file
   * endpoints, so trusting them queues transfers that cannot succeed and doubles
   * the item's apparent length.
   */
  function remountedServer() {
    const server = new MockAbsServer({ apiKeys: ['test-key'] });
    server.addLibrary('lib-1', 'Audiobooks', [
      {
        id: 'item-1',
        title: 'Dune',
        authorName: 'Frank Herbert',
        files: [
          { ino: '20049', filename: 'Dune - 01.mp3', fileType: 'audio', content: bytesFor('AUDIO-ONE') },
          { ino: '20050', filename: 'Dune - 02.mp3', fileType: 'audio', content: bytesFor('AUDIO-TWO') },
        ],
        phantomAudioFiles: [
          { ino: '562949953519992', filename: 'Dune - 01.mp3', size: 9 },
          { ino: '562949953519993', filename: 'Dune - 02.mp3', size: 9 },
        ],
      },
    ]);
    return server;
  }

  it('ignores media.audioFiles inos that libraryFiles does not know', async () => {
    const listing = await clientFor(remountedServer()).listItemFilesDetailed('item-1');
    expect(listing.files.map((f) => f.ino)).toEqual(['20049', '20050']);
    expect(listing.staleDuplicates).toBe(2);
    expect(listing.unfetchableAudio).toEqual([]);
  });

  it('every enumerated ino is actually downloadable', async () => {
    const client = clientFor(remountedServer());
    const listing = await client.listItemFilesDetailed('item-1');
    for (const file of listing.files) {
      const handle = await client.openFileDownload('item-1', file.ino);
      await drain(handle.stream);
    }
  });

  it('flags audio that exists in media.* but nowhere in libraryFiles', async () => {
    const server = new MockAbsServer({ apiKeys: ['test-key'] });
    server.addLibrary('lib-1', 'Audiobooks', [
      {
        id: 'item-1',
        title: 'Dune',
        files: [{ ino: 'ino-1', filename: 'Dune - 01.mp3', fileType: 'audio', content: bytesFor('ONE') }],
        phantomAudioFiles: [{ ino: 'ghost', filename: 'Dune - 02.mp3', size: 9 }],
      },
    ]);

    const listing = await clientFor(server).listItemFilesDetailed('item-1');
    expect(listing.files.map((f) => f.ino)).toEqual(['ino-1']);
    expect(listing.staleDuplicates).toBe(0);
    // Skipping this silently would upload an audiobook missing a chapter.
    expect(listing.unfetchableAudio).toEqual(['Dune - 02.mp3']);
  });

  it('falls back to media.audioFiles when the server omits libraryFiles', async () => {
    const server = new MockAbsServer({ apiKeys: ['test-key'] });
    server.addLibrary('lib-1', 'Audiobooks', [
      {
        id: 'item-1',
        title: 'Dune',
        files: [{ ino: 'ino-1', filename: 'Dune - 01.mp3', fileType: 'audio', content: bytesFor('ONE') }],
      },
    ]);
    // Simulate a payload with no file listing at all.
    const client = clientFor(server);
    const original = client.getLibraryItem.bind(client);
    client.getLibraryItem = async (id: string) => {
      const item = await original(id);
      return { ...item, libraryFiles: undefined };
    };

    const listing = await client.listItemFilesDetailed('item-1');
    expect(listing.files.map((f) => [f.ino, f.kind])).toEqual([['ino-1', 'audio']]);
    expect(listing.unfetchableAudio).toEqual([]);
  });
});

describe('uploads', () => {
  it('explains a reverse-proxy 413 instead of surfacing its HTML page', async () => {
    // The real failure: nginx in front of Audiobookshelf with client_max_body_size
    // at its 1 MB default. The status comes from the proxy, not from ABS, and the
    // body is an HTML error page that says nothing actionable.
    const server = new MockAbsServer({ apiKeys: ['test-key'], proxyRejectsUploads: true });
    server.addLibrary('lib-1', 'Audiobooks', []);

    const attempt = clientFor(server).upload({
      libraryId: 'lib-1',
      folderId: 'lib-1-folder',
      title: 'Dune',
      files: [
        {
          filename: 'Dune - 01.mp3',
          size: 9,
          open: () => streamOf(new TextEncoder().encode('AUDIO-ONE')),
        },
      ],
    });

    await expect(attempt).rejects.toThrow(/nginx\/1\.24\.0/);
    await expect(attempt).rejects.toThrow(/client_max_body_size/);
    // The point is that it names the proxy as the culprit, not Audiobookshelf.
    await expect(attempt).rejects.toThrow(/reverse proxy limit in front of Audiobookshelf/);
  });

  it('streams a multipart upload with ABS field names', async () => {
    const server = makeServer();
    const client = clientFor(server);
    const audio = new TextEncoder().encode('0123456789abcdefghij');
    const progress: number[] = [];

    const result = await client.upload({
      libraryId: 'lib-1',
      folderId: 'lib-1-folder',
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      series: 'Standalone',
      files: [
        { filename: 'part1.m4b', size: audio.byteLength, open: () => streamOf(audio) },
        { filename: 'part2.mp3', size: audio.byteLength, open: () => streamOf(audio) },
      ],
      onProgress: (bytes) => progress.push(bytes),
    });

    expect(result.success).toBe(true);
    expect(server.uploads).toHaveLength(1);
    const upload = server.uploads[0]!;
    expect(upload.fields).toEqual({
      library: 'lib-1',
      folder: 'lib-1-folder',
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      series: 'Standalone',
    });
    expect(upload.files.map((f) => f.field)).toEqual(['0', '1']);
    expect(upload.files[0]!.filename).toBe('part1.m4b');
    expect(upload.files[0]!.contentType).toBe('audio/mp4');
    expect(upload.files[1]!.contentType).toBe('audio/mpeg');
    expect(new TextDecoder().decode(upload.files[0]!.bytes)).toBe('0123456789abcdefghij');
    // Progress is cumulative across all file parts.
    expect(progress.at(-1)).toBe(audio.byteLength * 2);
  });

  it('treats a plain "OK" as success, because that is what ABS sends', async () => {
    // ABS 2.x ends its upload route with res.sendStatus(200): a gigabyte of
    // audio lands safely and the answer is the two characters "OK". Reading that
    // as malformed JSON used to fail the transfer and retry the whole upload.
    const server = makeServer();
    const result = await clientFor(server).upload({
      libraryId: 'lib-1',
      folderId: 'lib-1-folder',
      title: 'Mark of the Fool 10',
      files: [{ filename: 'a.mp3', size: 1, open: () => streamOf(new Uint8Array([1])) }],
    });

    expect(result.success).toBe(true);
    expect(result.libraryItem).toBeUndefined();
    expect(server.uploads).toHaveLength(1);
  });

  it('uses the new item id when a server does answer with JSON', async () => {
    const server = makeServer({ uploadReturnsJson: true });
    const result = await clientFor(server).upload({
      libraryId: 'lib-1',
      folderId: 'lib-1-folder',
      title: 'Mark of the Fool 10',
      files: [{ filename: 'a.mp3', size: 1, open: () => streamOf(new Uint8Array([1])) }],
    });

    expect(result.libraryItem?.id).toBe('uploaded-1');
  });

  it('hands the whole body to an injected upload transport, bypassing fetch', async () => {
    // Hosts that can stream a request body without holding it in memory inject a
    // transport; fetch must not see the upload at all when they do.
    const server = makeServer();
    const seen: Array<{ url: string; contentLength: number; headers: Record<string, string> }> = [];
    const client = clientFor(server, {
      uploadTransport: async (request) => {
        seen.push({
          url: request.url,
          contentLength: request.contentLength,
          headers: request.headers,
        });
        const body = new Uint8Array(await new Response(request.body).arrayBuffer());
        return new Response(JSON.stringify({ success: true, libraryItem: { id: `li_${body.byteLength}` } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const audio = new TextEncoder().encode('0123456789');
    const result = await client.upload({
      libraryId: 'lib-1',
      folderId: 'lib-1-folder',
      title: 'Transported',
      files: [{ filename: 'part1.mp3', size: audio.byteLength, open: () => streamOf(audio) }],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${server.baseUrl}/api/upload`);
    expect(seen[0]!.headers.authorization).toBe('Bearer test-key');
    expect(seen[0]!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    // The transport is told the exact length so it can send Content-Length.
    expect(result.libraryItem?.id).toBe(`li_${seen[0]!.contentLength}`);
    expect(server.uploads).toHaveLength(0);
    expect(server.requestLog).not.toContain('POST /api/upload');
  });

  it('rejects an upload with no files', async () => {
    const client = clientFor(makeServer());
    await expect(
      client.upload({ libraryId: 'lib-1', folderId: 'lib-1-folder', title: 'Empty', files: [] }),
    ).rejects.toThrow(/at least one file/);
  });

  it('surfaces server-side upload failures', async () => {
    const server = makeServer({ failUploads: true });
    const client = clientFor(server, { maxRetries: 0 });
    await expect(
      client.upload({
        libraryId: 'lib-1',
        folderId: 'lib-1-folder',
        title: 'Nope',
        files: [{ filename: 'a.mp3', size: 1, open: () => streamOf(new Uint8Array([1])) }],
      }),
    ).rejects.toBeInstanceOf(AbsHttpError);
  });

  it('raises an auth error when the account cannot upload', async () => {
    const server = makeServer({ permissions: { upload: false } });
    await expect(
      clientFor(server).upload({
        libraryId: 'lib-1',
        folderId: 'lib-1-folder',
        title: 'Nope',
        files: [{ filename: 'a.mp3', size: 1, open: () => streamOf(new Uint8Array([1])) }],
      }),
    ).rejects.toBeInstanceOf(AbsAuthError);
  });
});

describe('playback', () => {
  it('creates a session with absolute track URLs', async () => {
    const client = clientFor(makeServer());
    const session = await client.play('item-1');
    expect(session.audioTracks?.[0]?.contentUrl).toBe('/api/items/item-1/file/track-1');
    expect(client.absoluteUrl(session.audioTracks![0]!.contentUrl!)).toBe(
      'https://mock.abs.test/api/items/item-1/file/track-1',
    );
  });

  it('reports progress back to the server', async () => {
    const client = clientFor(makeServer());
    await expect(client.updateProgress('item-1', { currentTime: 120 })).resolves.toBeUndefined();
  });
});
