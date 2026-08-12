/**
 * In-memory Audiobookshelf stand-in used by tests.
 *
 * Exported (not test-only) so the web app's integration tests can drive the
 * indexer, diff and sync worker end-to-end without a real server.
 */
import type { AbsLibrary, AbsLibraryItem } from './types';

export interface MockItemInput {
  id: string;
  title: string;
  subtitle?: string | null;
  authorName?: string;
  narratorName?: string;
  seriesName?: string;
  asin?: string | null;
  isbn?: string | null;
  duration?: number;
  size?: number;
  numTracks?: number;
  mediaType?: string;
  isMissing?: boolean;
  /** Raw bytes served by the whole-item download endpoint. */
  content?: Uint8Array<ArrayBuffer>;
  /** Individual files, exposed via libraryFiles and the per-file endpoints. */
  files?: MockFile[];
  /**
   * Extra `media.audioFiles` entries with no matching `libraryFiles` record, so
   * their inos 404 on the file endpoints.
   *
   * Real servers do this: after a remount changes inode numbers,
   * `media.audioFiles` holds both the old and the new ino for every file while
   * `libraryFiles` only has the current ones. Measured on Audiobookshelf 2.35.1,
   * this affected 88% of one library.
   */
  phantomAudioFiles?: Array<{ ino: string; filename: string; size: number }>;
  /** Modification time in epoch millis, used by incremental indexing. */
  updatedAt?: number;
  /** Filesystem mtime. Real servers order by this but not by updatedAt. */
  mtimeMs?: number;
  /** Library-add time. */
  addedAt?: number;
}

export interface MockFile {
  ino: string;
  filename: string;
  fileType: 'audio' | 'ebook' | 'image' | 'metadata';
  content: Uint8Array<ArrayBuffer>;
}

export interface MockServerOptions {
  /** Valid API keys. */
  apiKeys?: string[];
  /** Valid username/password pairs; login returns `token`. */
  users?: Array<{ username: string; password: string; token: string; type?: string }>;
  serverVersion?: string;
  /** Which download URL shape this mock accepts, mirroring version differences. */
  downloadStyle?: 'item' | 'library';
  /** Force upload failures to exercise retry/error paths. */
  failUploads?: boolean;
  /**
   * Answer a successful upload with JSON naming the new item.
   *
   * Audiobookshelf 2.x does not: its upload route ends in `res.sendStatus(200)`,
   * so the body is the plain text `OK` and the caller never learns the item id.
   * That is what this mock does by default. Set this to cover a server that
   * answers with a body worth reading.
   */
  uploadReturnsJson?: boolean;
  /**
   * Answer uploads with a reverse-proxy 413 HTML error page, as an
   * Audiobookshelf behind nginx does when `client_max_body_size` is left at its
   * 1 MB default.
   */
  proxyRejectsUploads?: boolean;
  /** "download" means only /file/:ino/download works, not the bare /file/:ino. */
  fileEndpointStyle?: 'both' | 'download';
  /** Return 500 for the first N requests to a path, to exercise retries. */
  flakyPath?: { path: string; failures: number };
  permissions?: { download?: boolean; upload?: boolean };
  userType?: string;
  /** Origin this mock answers on. Give each mock a distinct host when routing
   * several of them through one global fetch. */
  baseUrl?: string;
  /**
   * Sort keys this mock understands. Anything else is silently ignored, exactly
   * as Audiobookshelf does — which is the case incremental indexing has to
   * detect rather than trust.
   */
  supportedSortKeys?: string[];
}

export interface UploadCapture {
  fields: Record<string, string>;
  files: Array<{ field: string; filename: string; contentType: string; bytes: Uint8Array }>;
}

export class MockAbsServer {
  readonly baseUrl: string;
  readonly uploads: UploadCapture[] = [];
  readonly requestLog: string[] = [];
  /** Counts /items page fetches, so tests can assert incremental is cheap. */
  itemPageRequests = 0;

  private readonly libraries = new Map<string, { library: AbsLibrary; items: MockItemInput[] }>();
  private readonly options: MockServerOptions;
  private flakyRemaining: number;

  constructor(options: MockServerOptions = {}) {
    this.options = options;
    this.baseUrl = options.baseUrl ?? 'https://mock.abs.test';
    this.flakyRemaining = options.flakyPath?.failures ?? 0;
  }

  /** Adds an item to an existing library, as if a book appeared upstream. */
  addItem(libraryId: string, item: MockItemInput): this {
    const entry = this.libraries.get(libraryId);
    if (!entry) throw new Error(`unknown library ${libraryId}`);
    entry.items.push(item);
    return this;
  }

  /** Removes an item, as if a book were deleted upstream. */
  removeItem(libraryId: string, itemId: string): this {
    const entry = this.libraries.get(libraryId);
    if (!entry) throw new Error(`unknown library ${libraryId}`);
    entry.items = entry.items.filter((candidate) => candidate.id !== itemId);
    return this;
  }

  addLibrary(id: string, name: string, items: MockItemInput[], folderId = `${id}-folder`): this {
    this.libraries.set(id, {
      library: {
        id,
        name,
        mediaType: 'book',
        folders: [{ id: folderId, fullPath: `/audiobooks/${name}`, libraryId: id }],
      },
      items,
    });
    return this;
  }

  /** A `fetch` implementation to hand to AbsClient. */
  get fetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.pathname;
      this.requestLog.push(`${method} ${path}`);

      if (this.options.flakyPath && path === this.options.flakyPath.path && this.flakyRemaining > 0) {
        this.flakyRemaining--;
        return json({ error: 'transient' }, 503);
      }

      if (path === '/status') {
        return json({ isInit: true, serverVersion: this.options.serverVersion ?? '2.26.0' });
      }

      if (path === '/login' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { username?: string; password?: string };
        const user = (this.options.users ?? []).find(
          (candidate) => candidate.username === body.username && candidate.password === body.password,
        );
        if (!user) return json({ error: 'Invalid user or password' }, 401);
        return json({
          user: {
            id: `user-${user.username}`,
            username: user.username,
            type: user.type ?? 'user',
            token: user.token,
            permissions: this.permissions(),
          },
        });
      }

      const authError = this.checkAuth(init);
      if (authError) return authError;

      if (path === '/api/me') {
        return json({
          id: 'user-1',
          username: 'tester',
          type: this.options.userType ?? 'admin',
          permissions: this.permissions(),
        });
      }

      if (path === '/api/libraries' && method === 'GET') {
        return json({ libraries: [...this.libraries.values()].map((entry) => entry.library) });
      }

      const libraryMatch = /^\/api\/libraries\/([^/]+)$/.exec(path);
      if (libraryMatch && method === 'GET') {
        const entry = this.libraries.get(decodeURIComponent(libraryMatch[1]!));
        return entry ? json(entry.library) : json({ error: 'not found' }, 404);
      }

      const itemsMatch = /^\/api\/libraries\/([^/]+)\/items$/.exec(path);
      if (itemsMatch && method === 'GET') {
        const entry = this.libraries.get(decodeURIComponent(itemsMatch[1]!));
        if (!entry) return json({ error: 'not found' }, 404);
        const page = Number(url.searchParams.get('page') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? '100');

        const sortKey = url.searchParams.get('sort') ?? '';
        const desc = url.searchParams.get('desc') === '1';
        // Permissive by default; individual tests narrow this to model servers
        // that ignore particular keys (real ABS honours mtimeMs and addedAt but
        // not updatedAt).
        const supported =
          this.options.supportedSortKeys ??
          ['mtimeMs', 'addedAt', 'updatedAt', 'media.metadata.title'];
        let ordered = entry.items;
        if (supported.includes(sortKey)) {
          const keyOf = (item: MockItemInput): number =>
            sortKey === 'mtimeMs'
              ? (item.mtimeMs ?? item.updatedAt ?? 0)
              : sortKey === 'addedAt'
                ? (item.addedAt ?? item.updatedAt ?? 0)
                : (item.updatedAt ?? 0);
          ordered = [...entry.items].sort((a, b) => {
            const compared =
              sortKey === 'media.metadata.title'
                ? a.title.localeCompare(b.title)
                : keyOf(a) - keyOf(b);
            return desc ? -compared : compared;
          });
        }
        // An unsupported sort key falls through with insertion order preserved.

        const start = page * limit;
        const slice = ordered.slice(start, start + limit);
        this.itemPageRequests++;
        return json({
          results: slice.map((item) => this.toAbsItem(item, entry.library.id!, url.searchParams.get('minified') === '1')),
          total: entry.items.length,
          limit,
          page,
        });
      }

      const seriesMatch = /^\/api\/libraries\/([^/]+)\/series$/.exec(path);
      if (seriesMatch && method === 'GET') {
        const entry = this.libraries.get(decodeURIComponent(seriesMatch[1]!));
        if (!entry) return json({ error: 'not found' }, 404);
        const names = new Map<string, MockItemInput[]>();
        for (const item of entry.items) {
          if (!item.seriesName) continue;
          const name = item.seriesName.split('#')[0]!.trim();
          const list = names.get(name) ?? [];
          list.push(item);
          names.set(name, list);
        }
        return json({
          results: [...names.entries()].map(([name, items]) => ({
            id: `series-${name}`,
            name,
            books: items.map((item) => this.toAbsItem(item, entry.library.id!, true)),
          })),
          total: names.size,
        });
      }

      const itemMatch = /^\/api\/items\/([^/]+)$/.exec(path);
      if (itemMatch && method === 'GET') {
        const id = decodeURIComponent(itemMatch[1]!);
        for (const entry of this.libraries.values()) {
          const item = entry.items.find((candidate) => candidate.id === id);
          if (item) return json(this.toAbsItem(item, entry.library.id!, false));
        }
        return json({ error: 'not found' }, 404);
      }

      const fileDownload = /^\/api\/items\/([^/]+)\/file\/([^/]+?)(\/download)?$/.exec(path);
      if (fileDownload && method === 'GET') {
        if (!this.permissions().download) return json({ error: 'forbidden' }, 403);
        // Mirror servers that only expose the /download form.
        if (this.options.fileEndpointStyle === 'download' && !fileDownload[3]) {
          return json({ error: 'not found' }, 404);
        }
        const item = this.findItem(decodeURIComponent(fileDownload[1]!));
        const file = item?.files?.find((candidate) => candidate.ino === decodeURIComponent(fileDownload[2]!));
        if (!file) return json({ error: 'not found' }, 404);
        return new Response(file.content, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(file.content.byteLength),
            'content-disposition': `attachment; filename="${file.filename}"`,
          },
        });
      }

      const itemDownload = /^\/api\/items\/([^/]+)\/download$/.exec(path);
      const libraryDownload = /^\/api\/libraries\/([^/]+)\/items\/([^/]+)\/download$/.exec(path);
      if (itemDownload || libraryDownload) {
        const style = this.options.downloadStyle ?? 'item';
        if (style === 'item' && !itemDownload) return json({ error: 'not found' }, 404);
        if (style === 'library' && !libraryDownload) return json({ error: 'not found' }, 404);
        if (!this.permissions().download) return json({ error: 'forbidden' }, 403);

        const id = decodeURIComponent((itemDownload ? itemDownload[1] : libraryDownload![2])!);
        const found = this.findItem(id);
        if (!found) return json({ error: 'not found' }, 404);
        const bytes: Uint8Array<ArrayBuffer> = found.content ?? new TextEncoder().encode(`audio:${id}`);
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-length': String(bytes.byteLength),
            'content-disposition': `attachment; filename="${found.title}.zip"`,
          },
        });
      }

      if (path === '/api/upload' && method === 'POST') {
        if (this.options.proxyRejectsUploads) {
          return new Response(
            '<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n' +
              '<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n' +
              '<hr><center>nginx/1.24.0 (Ubuntu)</center>\r\n</body>\r\n</html>',
            { status: 413, statusText: 'Request Entity Too Large', headers: { 'content-type': 'text/html' } },
          );
        }
        if (this.options.failUploads) return json({ error: 'upload failed' }, 500);
        if (!this.permissions().upload) return json({ error: 'forbidden' }, 403);
        const contentType = headerOf(init, 'content-type');
        const capture = await parseMultipart(init?.body, contentType);
        this.uploads.push(capture);
        if (this.options.uploadReturnsJson) {
          return json({ success: true, libraryItem: { id: `uploaded-${this.uploads.length}` } });
        }
        // What Audiobookshelf really sends: sendStatus(200), i.e. text `OK`.
        return new Response('OK', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }

      const playMatch = /^\/api\/items\/([^/]+)\/play$/.exec(path);
      if (playMatch && method === 'POST') {
        const id = decodeURIComponent(playMatch[1]!);
        const found = this.findItem(id);
        if (!found) return json({ error: 'not found' }, 404);
        return json({
          id: `session-${id}`,
          libraryItemId: id,
          audioTracks: [
            {
              index: 1,
              startOffset: 0,
              duration: found.duration ?? 3600,
              contentUrl: `/api/items/${id}/file/track-1`,
              mimeType: 'audio/mpeg',
            },
          ],
          duration: found.duration ?? 3600,
        });
      }

      if (/^\/api\/me\/progress\//.test(path) && method === 'PATCH') {
        return json({ success: true });
      }

      return json({ error: `unhandled ${method} ${path}` }, 404);
    }) as typeof fetch;
  }

  private permissions() {
    return {
      download: this.options.permissions?.download ?? true,
      upload: this.options.permissions?.upload ?? true,
    };
  }

  private checkAuth(init?: RequestInit): Response | null {
    const header = headerOf(init, 'authorization');
    const token = header?.replace(/^Bearer\s+/i, '') ?? '';
    const validKeys = this.options.apiKeys ?? [];
    const validTokens = (this.options.users ?? []).map((user) => user.token);
    if (!token) return json({ error: 'Unauthorized' }, 401);
    if (!validKeys.includes(token) && !validTokens.includes(token)) {
      return json({ error: 'Unauthorized' }, 401);
    }
    return null;
  }

  private findItem(id: string): MockItemInput | null {
    for (const entry of this.libraries.values()) {
      const item = entry.items.find((candidate) => candidate.id === id);
      if (item) return item;
    }
    return null;
  }

  private toAbsItem(item: MockItemInput, libraryId: string, minified: boolean): AbsLibraryItem {
    const metadata = minified
      ? {
          title: item.title,
          subtitle: item.subtitle ?? null,
          authorName: item.authorName ?? '',
          narratorName: item.narratorName ?? '',
          seriesName: item.seriesName ?? '',
          // Minified payloads on some versions omit identifiers entirely.
          publishedYear: null,
        }
      : {
          title: item.title,
          subtitle: item.subtitle ?? null,
          authors: (item.authorName ?? '')
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)
            .map((name) => ({ id: `author-${name}`, name })),
          narrators: (item.narratorName ?? '')
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean),
          series: item.seriesName
            ? [
                {
                  id: 'series-1',
                  name: item.seriesName.split('#')[0]!.trim(),
                  sequence: item.seriesName.includes('#')
                    ? item.seriesName.split('#')[1]!.trim()
                    : null,
                },
              ]
            : [],
          asin: item.asin ?? null,
          isbn: item.isbn ?? null,
        };

    const audioFiles = [
      ...(item.files ?? [])
        .filter((file) => file.fileType === 'audio')
        .map((file) => ({ ino: file.ino, filename: file.filename, size: file.content.byteLength })),
      ...(item.phantomAudioFiles ?? []),
    ].map((file, index) => ({
      index: index + 1,
      ino: file.ino,
      metadata: { filename: file.filename, size: file.size },
    }));

    return {
      id: item.id,
      libraryId,
      folderId: `${libraryId}-folder`,
      mediaType: item.mediaType ?? 'book',
      isMissing: item.isMissing ?? false,
      size: item.size ?? 1024,
      numFiles: item.numTracks ?? 1,
      updatedAt: item.updatedAt ?? 1_700_000_000_000,
      mtimeMs: item.mtimeMs ?? item.updatedAt ?? 1_700_000_000_000,
      addedAt: item.addedAt ?? item.updatedAt ?? 1_700_000_000_000,
      // Only full (non-minified) payloads carry the file list, as in real ABS.
      libraryFiles: minified
        ? undefined
        : (item.files ?? []).map((file) => ({
            ino: file.ino,
            fileType: file.fileType,
            metadata: { filename: file.filename, size: file.content.byteLength },
          })),
      media: {
        metadata,
        duration: item.duration ?? 3600,
        size: item.size ?? 1024,
        numTracks: item.numTracks ?? audioFiles.length ?? 1,
        audioFiles: minified ? undefined : audioFiles,
      },
    };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name);
    return found?.[1] ?? null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return String(value);
  }
  return null;
}

async function collect(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof ReadableStream) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
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
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function indexOfSequence(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Minimal multipart parser sufficient to verify what we actually send. */
async function parseMultipart(
  body: BodyInit | null | undefined,
  contentType: string | null,
): Promise<UploadCapture> {
  const capture: UploadCapture = { fields: {}, files: [] };
  const boundary = /boundary=([^;]+)/i.exec(contentType ?? '')?.[1];
  if (!boundary) return capture;

  const bytes = await collect(body);
  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`--${boundary}`);
  const headerEnd = encoder.encode('\r\n\r\n');

  let cursor = indexOfSequence(bytes, delimiter, 0);
  while (cursor !== -1) {
    let start = cursor + delimiter.length;
    // End marker.
    if (bytes[start] === 0x2d && bytes[start + 1] === 0x2d) break;
    start += 2; // skip CRLF after the boundary

    const headerStop = indexOfSequence(bytes, headerEnd, start);
    if (headerStop === -1) break;
    const rawHeaders = new TextDecoder().decode(bytes.subarray(start, headerStop));
    const bodyStart = headerStop + headerEnd.length;
    const next = indexOfSequence(bytes, delimiter, bodyStart);
    if (next === -1) break;
    // Strip the trailing CRLF that precedes the next boundary.
    const bodyBytes = bytes.subarray(bodyStart, next - 2);

    const name = /name="([^"]*)"/i.exec(rawHeaders)?.[1] ?? '';
    const filename = /filename="([^"]*)"/i.exec(rawHeaders)?.[1];
    const partType = /Content-Type:\s*([^\r\n]+)/i.exec(rawHeaders)?.[1] ?? '';

    if (filename === undefined) {
      capture.fields[name] = new TextDecoder().decode(bodyBytes);
    } else {
      capture.files.push({
        field: name,
        filename,
        contentType: partType.trim(),
        bytes: new Uint8Array(bodyBytes),
      });
    }
    cursor = next;
  }

  return capture;
}
