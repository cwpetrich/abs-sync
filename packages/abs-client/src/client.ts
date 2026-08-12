import type { BookRecord } from '@abs-sync/core';
import {
  AbsAuthError,
  AbsConnectionError,
  AbsHttpError,
  AbsPayloadTooLargeError,
  AbsProtocolError,
} from './errors';
import { absItemToBookRecord } from './map';
import { buildMultipartBody, type MultipartBody, type MultipartPart } from './multipart';
import type {
  AbsLibrariesResponse,
  AbsLibrary,
  AbsLibraryItem,
  AbsLoginResponse,
  AbsPagedItems,
  AbsPagedSeries,
  AbsPlaybackSession,
  AbsSeries,
  AbsStatus,
  AbsUploadResponse,
  AbsUser,
} from './types';

export type AbsAuth =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'password'; username: string; password: string };

export interface UploadTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
  /** Exact encoded body length, so the transport can set Content-Length. */
  contentLength: number;
  signal?: AbortSignal;
}

/**
 * Alternative sender for the one request that streams gigabytes.
 *
 * `fetch` is fine for JSON and for *receiving* downloads, but every runtime
 * tested retains each chunk of a streamed *request* body until the request
 * finishes, so memory grows with the upload and a multi-gigabyte audiobook ends
 * the process ("JavaScript heap out of memory"). Hosts that can do better —
 * Node, via `node:http` — inject a transport here. Left unset, `upload()` falls
 * back to `fetch`, which keeps this package usable from React Native and the
 * browser where nothing else exists.
 */
export type UploadTransport = (request: UploadTransportRequest) => Promise<Response>;

export interface AbsClientOptions {
  /** Base server URL, e.g. `https://abs.example.com` (trailing slash optional). */
  baseUrl: string;
  auth: AbsAuth;
  fetchImpl?: typeof fetch;
  /** Memory-flat sender for `upload()`. See {@link UploadTransport}. */
  uploadTransport?: UploadTransport;
  /** Per-request timeout for JSON calls. Streaming transfers are exempt. */
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
  /** A previously obtained bearer token to reuse, avoiding a fresh login. */
  initialToken?: string;
  /** Invoked whenever a login produces a new token, so callers can persist it. */
  onToken?: (token: string) => void;
  /**
   * Namespaces the `key` on emitted records. Pass the database id of the server
   * so records stay stable even if the URL changes.
   */
  serverKey?: string;
}

export interface AbsIdentity {
  user: AbsUser;
  serverVersion: string | null;
  /** Capabilities that gate what this app can actually do. */
  canDownload: boolean;
  canUpload: boolean;
  isAdmin: boolean;
}

export interface DownloadHandle {
  stream: ReadableStream<Uint8Array>;
  /** Null when the server does not advertise a length (chunked zip). */
  contentLength: number | null;
  contentType: string | null;
  filename: string;
  /** Which endpoint template served this download, for diagnostics. */
  endpoint: string;
}

export type AbsFileKind = 'audio' | 'ebook' | 'image' | 'other';

export interface AbsItemFile {
  /** Inode id, the handle ABS uses to address a single file within an item. */
  ino: string;
  filename: string;
  size: number;
  kind: AbsFileKind;
}

export interface ItemFileListing {
  /** Files that can actually be fetched, i.e. present in `libraryFiles`. */
  files: AbsItemFile[];
  /**
   * Audio entries in `media.*` that duplicate a file already in `libraryFiles`
   * under a different ino. Harmless to skip, but they inflate the item's
   * reported duration and file count, so callers may want to warn.
   */
  staleDuplicates: number;
  /**
   * Audio filenames present in `media.*` with no corresponding `libraryFiles`
   * entry. These cannot be downloaded by any endpoint, so transferring the item
   * would produce an incomplete audiobook.
   */
  unfetchableAudio: string[];
}

export interface ModifiedSinceResult {
  records: BookRecord[];
  /**
   * False when no candidate sort key produced a correctly ordered response.
   * The caller must do a full crawl; the records here are not trustworthy.
   */
  ordered: boolean;
  /** The sort key that was attempted. */
  sortField: string;
  pagesFetched: number;
  /** True when an item older than `since` was reached, i.e. we saw everything new. */
  reachedOlder: boolean;
  /** True when paging ran off the end of the library without reaching `since`. */
  exhausted: boolean;
}

export interface UploadRequest {
  libraryId: string;
  folderId: string;
  title: string;
  author?: string;
  series?: string;
  files: Array<{
    filename: string;
    size: number;
    contentType?: string;
    open: () => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
  }>;
  onProgress?: (bytesSent: number) => void;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) throw new AbsProtocolError('Server URL is empty');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    // Validate early so a typo surfaces as a config error, not a fetch failure.
    new URL(withScheme);
  } catch (cause) {
    throw new AbsProtocolError(`Invalid server URL: ${raw}`, { cause });
  }
  return withScheme;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
      },
      { once: true },
    );
  });
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => Boolean(s));
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  // AbortSignal.any is available on Node 20.3+ and all current browsers.
  return AbortSignal.any(present);
}

export class AbsClient {
  readonly baseUrl: string;
  private readonly auth: AbsAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly uploadTransport: UploadTransport | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly onToken: ((token: string) => void) | undefined;

  /** Namespaces emitted record keys; defaults to the base URL when unset. */
  private readonly serverKey: string;
  /** Bearer value in use: the API key, or the token from a password login. */
  private token: string | null;
  private loginInFlight: Promise<string> | null = null;
  /** Remembers which download URL shape this server accepts. */
  private downloadTemplate: 'item' | 'library' | null = null;

  constructor(options: AbsClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.uploadTransport = options.uploadTransport;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.userAgent = options.userAgent ?? 'abs-sync/0.1';
    this.onToken = options.onToken;
    this.serverKey = options.serverKey ?? this.baseUrl;
    this.token = options.auth.kind === 'apiKey' ? options.auth.apiKey : (options.initialToken ?? null);
  }

  /** Current bearer token, so callers can cache it between runs. */
  get currentToken(): string | null {
    return this.token;
  }

  private url(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    if (this.auth.kind === 'apiKey') {
      throw new AbsAuthError('No API key configured', { serverUrl: this.baseUrl });
    }
    // Collapse concurrent logins into one request.
    this.loginInFlight ??= this.login().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /** Authenticates with username/password and caches the resulting token. */
  async login(): Promise<string> {
    if (this.auth.kind !== 'password') {
      throw new AbsAuthError('login() requires username/password auth', { serverUrl: this.baseUrl });
    }
    const response = await this.rawFetch('POST', '/login', {
      body: JSON.stringify({ username: this.auth.username, password: this.auth.password }),
      headers: { 'content-type': 'application/json' },
      skipAuth: true,
    });

    if (response.status === 401) {
      throw new AbsAuthError('Invalid username or password', { serverUrl: this.baseUrl });
    }
    await this.assertOk(response, 'POST', '/login');

    const payload = (await this.parseJson<AbsLoginResponse>(response, '/login')) ?? {};
    // Token location moved between versions; accept every known shape.
    const token = payload.user?.accessToken ?? payload.user?.token ?? payload.accessToken ?? null;
    if (!token) {
      throw new AbsProtocolError(
        'Login succeeded but no token was returned; the server may require OIDC or an API key',
        { serverUrl: this.baseUrl },
      );
    }
    this.token = token;
    this.onToken?.(token);
    return token;
  }

  /** Standard headers for an authenticated request, including the bearer token. */
  private async requestHeaders(
    extra: Record<string, string> = {},
    skipAuth = false,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.userAgent,
      ...extra,
    };
    if (!skipAuth) {
      const token = await this.ensureToken();
      headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private async rawFetch(
    method: string,
    path: string,
    init: {
      body?: BodyInit | null;
      headers?: Record<string, string>;
      skipAuth?: boolean;
      signal?: AbortSignal;
      /** Streaming bodies need duplex: 'half' and no timeout. */
      stream?: boolean;
      query?: Record<string, string | number | boolean | undefined>;
    } = {},
  ): Promise<Response> {
    const headers = await this.requestHeaders(init.headers, init.skipAuth);
    const timeoutSignal = init.stream ? undefined : AbortSignal.timeout(this.timeoutMs);
    const signal = combineSignals([init.signal, timeoutSignal]);

    const request: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
      body: init.body ?? null,
      redirect: 'follow',
    };
    if (signal) request.signal = signal;
    if (init.body instanceof ReadableStream) request.duplex = 'half';

    try {
      return await this.fetchImpl(this.url(path, init.query), request);
    } catch (cause) {
      const message =
        cause instanceof Error && cause.name === 'TimeoutError'
          ? `Request timed out after ${this.timeoutMs}ms: ${method} ${path}`
          : `Could not reach ${this.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`;
      if (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError')) {
        // A caller-initiated abort must propagate unchanged so cancellation works.
        if (init.signal?.aborted) throw cause;
      }
      throw new AbsConnectionError(message, { serverUrl: this.baseUrl, cause });
    }
  }

  private async assertOk(response: Response, method: string, path: string): Promise<void> {
    if (response.ok) return;
    let snippet = '';
    try {
      snippet = (await response.text()).slice(0, 300).replace(/\s+/g, ' ').trim();
    } catch {
      // Body already consumed or unreadable; the status alone is enough.
    }
    if (response.status === 401 || response.status === 403) {
      throw new AbsAuthError(
        response.status === 401
          ? 'Authentication rejected (token or API key invalid/expired)'
          : `Permission denied for ${method} ${path} — the account behind this credential lacks the required permission`,
        { serverUrl: this.baseUrl },
      );
    }
    // A 413 essentially always comes from a reverse proxy rather than
    // Audiobookshelf, and the raw body is an HTML error page that tells the user
    // nothing actionable. nginx defaults `client_max_body_size` to 1 MB, which
    // no audiobook will ever fit inside, so name the fix instead.
    if (response.status === 413) {
      throw new AbsPayloadTooLargeError(
        `${describeProxy(snippet)} rejected ${method} ${path} as too large (413). This is a reverse ` +
          'proxy limit in front of Audiobookshelf, not Audiobookshelf itself — raise the body size ' +
          'limit for this host (nginx: `client_max_body_size 0;` plus ' +
          '`proxy_request_buffering off;` so large uploads stream through instead of buffering to ' +
          'disk) and reload it.',
        { serverUrl: this.baseUrl },
      );
    }
    throw new AbsHttpError({
      status: response.status,
      statusText: response.statusText,
      method,
      path,
      bodySnippet: snippet,
      serverUrl: this.baseUrl,
    });
  }

  private async parseJson<T>(response: Response, path: string): Promise<T | null> {
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      const looksLikeHtml = /^\s*</.test(text);
      throw new AbsProtocolError(
        looksLikeHtml
          ? `${path} returned HTML instead of JSON — check that the URL points at the Audiobookshelf API and not a reverse proxy login page`
          : `${path} returned malformed JSON`,
        { serverUrl: this.baseUrl, cause },
      );
    }
  }

  /** JSON request with retry/backoff on transient failures and one auth refresh. */
  private async requestJson<T>(
    method: string,
    path: string,
    init: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      signal?: AbortSignal;
      skipAuth?: boolean;
    } = {},
  ): Promise<T | null> {
    let attempt = 0;
    let refreshed = false;

    for (;;) {
      const fetchInit: Parameters<AbsClient['rawFetch']>[2] = {
        signal: init.signal,
        skipAuth: init.skipAuth,
        query: init.query,
      };
      if (init.body !== undefined) {
        fetchInit.body = JSON.stringify(init.body);
        fetchInit.headers = { 'content-type': 'application/json' };
      }

      try {
        const response = await this.rawFetch(method, path, fetchInit);
        await this.assertOk(response, method, path);
        return await this.parseJson<T>(response, path);
      } catch (error) {
        // A password-auth token can expire mid-run; re-login once and retry.
        if (
          error instanceof AbsAuthError &&
          this.auth.kind === 'password' &&
          !refreshed &&
          !init.skipAuth
        ) {
          refreshed = true;
          this.token = null;
          await this.ensureToken();
          continue;
        }

        const retryable =
          (error instanceof AbsHttpError && error.isRetryable) || error instanceof AbsConnectionError;
        if (!retryable || attempt >= this.maxRetries || init.signal?.aborted) throw error;

        attempt++;
        const backoff = Math.min(8_000, 2 ** attempt * 250) * (0.75 + Math.random() * 0.5);
        await sleep(backoff, init.signal);
      }
    }
  }

  // ---------------------------------------------------------------- discovery

  /** Unauthenticated server probe. Confirms the URL really is Audiobookshelf. */
  async getStatus(signal?: AbortSignal): Promise<AbsStatus> {
    const status = await this.requestJson<AbsStatus>('GET', '/status', { skipAuth: true, signal });
    if (!status || typeof status !== 'object') {
      throw new AbsProtocolError('/status did not return a server descriptor', {
        serverUrl: this.baseUrl,
      });
    }
    return status;
  }

  /** Verifies the credential and reports what it is allowed to do. */
  async verify(signal?: AbortSignal): Promise<AbsIdentity> {
    let serverVersion: string | null = null;
    try {
      serverVersion = (await this.getStatus(signal)).serverVersion ?? null;
    } catch {
      // /status is a nicety; a working /api/me is what actually matters.
    }

    const user = await this.requestJson<AbsUser>('GET', '/api/me', { signal });
    if (!user?.id && !user?.username) {
      throw new AbsProtocolError('/api/me did not return a user', { serverUrl: this.baseUrl });
    }

    const isAdmin = user.type === 'admin' || user.type === 'root';
    const permissions = user.permissions ?? {};
    return {
      user,
      serverVersion,
      // Admins implicitly hold every permission in ABS.
      canDownload: isAdmin || permissions.download === true,
      canUpload: isAdmin || permissions.upload === true,
      isAdmin,
    };
  }

  async getLibraries(signal?: AbortSignal): Promise<AbsLibrary[]> {
    const payload = await this.requestJson<AbsLibrariesResponse | AbsLibrary[]>('GET', '/api/libraries', {
      signal,
    });
    const libraries = Array.isArray(payload) ? payload : (payload?.libraries ?? []);
    return libraries.filter((library) => Boolean(library?.id));
  }

  async getLibrary(libraryId: string, signal?: AbortSignal): Promise<AbsLibrary> {
    const payload = await this.requestJson<AbsLibrary | { library?: AbsLibrary }>(
      'GET',
      `/api/libraries/${encodeURIComponent(libraryId)}`,
      { signal },
    );
    const library =
      payload && 'library' in payload && payload.library ? payload.library : (payload as AbsLibrary);
    if (!library?.id) {
      throw new AbsProtocolError(`Library ${libraryId} not found`, { serverUrl: this.baseUrl });
    }
    return library;
  }

  async listLibraryItems(
    libraryId: string,
    options: {
      page?: number;
      limit?: number;
      minified?: boolean;
      /** ABS sort key. Defaults to title for stable full-crawl paging. */
      sort?: string;
      desc?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<AbsPagedItems> {
    const payload = await this.requestJson<AbsPagedItems>(
      'GET',
      `/api/libraries/${encodeURIComponent(libraryId)}/items`,
      {
        query: {
          page: options.page ?? 0,
          limit: options.limit ?? 100,
          minified: (options.minified ?? true) ? 1 : 0,
          // Series collapsing would hide individual books from the diff.
          collapseseries: 0,
          sort: options.sort ?? 'media.metadata.title',
          ...(options.desc ? { desc: 1 } : {}),
        },
        signal: options.signal,
      },
    );
    return payload ?? { results: [], total: 0 };
  }

  /**
   * Sort keys worth trying for "newest first", best first.
   *
   * Determined against real servers: Audiobookshelf honours `mtimeMs` and
   * `addedAt` but does NOT return `updatedAt` in any consistent order, so
   * `updatedAt` is last and will simply fail validation where unsupported.
   * `mtimeMs` is preferred because it moves when an item's files change, not
   * only when it is first added.
   */
  static readonly MODIFIED_SORT_CANDIDATES = ['mtimeMs', 'addedAt', 'updatedAt'] as const;

  /**
   * Fetches items whose `sortField` timestamp is at or after `since`, newest
   * first, stopping as soon as an older item appears.
   *
   * Audiobookshelf has no "changes since" endpoint, so this leans on sorting —
   * and servers silently ignore a sort key they do not recognise. Returning a
   * page in the wrong order while we stop early would index a sliver of the
   * library and silently report the rest as missing, so the ordering is verified
   * against the payload and `ordered: false` is reported rather than guessed at.
   *
   * The field validated is always the one sorted by. Reading some other
   * timestamp would reject a perfectly good response: ABS populates `updatedAt`
   * on every item but does not order by it, so a `mtimeMs`-sorted page looks
   * unsorted if you check `updatedAt`.
   */
  async fetchBooksModifiedSince(
    libraryId: string,
    options: {
      /** Epoch millis, taken from the server's own timestamps, not our clock. */
      since: number;
      /** Which key to sort and compare by. See MODIFIED_SORT_CANDIDATES. */
      sortField: string;
      pageSize?: number;
      /** Safety valve: beyond this, a full crawl is cheaper anyway. */
      maxPages?: number;
      minified?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<ModifiedSinceResult> {
    const pageSize = options.pageSize ?? 100;
    const maxPages = options.maxPages ?? 20;
    const minified = options.minified ?? true;
    const sortField = options.sortField;

    const records: BookRecord[] = [];
    let pagesFetched = 0;
    let reachedOlder = false;
    let exhausted = false;
    let previousStamp = Number.POSITIVE_INFINITY;

    for (let page = 0; page < maxPages; page++) {
      if (options.signal?.aborted) {
        return { records, ordered: true, sortField, pagesFetched, reachedOlder, exhausted: false };
      }

      const batch = await this.listLibraryItems(libraryId, {
        page,
        limit: pageSize,
        minified,
        sort: sortField,
        desc: true,
        signal: options.signal,
      });
      pagesFetched++;
      const results = batch.results ?? [];
      if (results.length === 0) {
        exhausted = true;
        break;
      }

      // Validate the ordering of the WHOLE page before acting on any of it.
      // Checking as we go would let an early stop on the first old item mask a
      // sort key the server ignored — and we would then report "nothing
      // changed" for a library full of new books.
      const stamps = results.map((item) => timestampFor(item, sortField));
      if (stamps.some((stamp) => stamp === null)) {
        return { records: [], ordered: false, sortField, pagesFetched, reachedOlder: false, exhausted: false };
      }
      const pageStamps = stamps as number[];
      if (pageStamps[0]! > previousStamp) {
        return { records: [], ordered: false, sortField, pagesFetched, reachedOlder: false, exhausted: false };
      }
      for (let i = 1; i < pageStamps.length; i++) {
        if (pageStamps[i]! > pageStamps[i - 1]!) {
          return {
            records: [],
            ordered: false,
            sortField,
            pagesFetched,
            reachedOlder: false,
            exhausted: false,
          };
        }
      }
      previousStamp = pageStamps[pageStamps.length - 1]!;

      for (const [index, item] of results.entries()) {
        if (pageStamps[index]! < options.since) {
          reachedOlder = true;
          break;
        }
        const record = absItemToBookRecord(this.serverKey, item, libraryId);
        if (record) records.push(record);
      }

      if (reachedOlder) break;
      if (results.length < pageSize) {
        exhausted = true;
        break;
      }
    }

    return { records, ordered: true, sortField, pagesFetched, reachedOlder, exhausted };
  }

  /**
   * Pages through an entire library, yielding canonical records.
   *
   * Uses `minified=1` by default: full payloads embed every library file's
   * metadata, which is megabytes per item on large libraries. Minified omits
   * ASIN/ISBN on some server versions, so pass `enrich: true` to backfill
   * identifiers for items that lack them (costs one request per such item).
   */
  async *iterateBooks(
    libraryId: string,
    options: {
      pageSize?: number;
      minified?: boolean;
      enrich?: boolean;
      signal?: AbortSignal;
      onProgress?: (loaded: number, total: number | null) => void;
    } = {},
  ): AsyncGenerator<BookRecord> {
    const pageSize = options.pageSize ?? 100;
    let page = 0;
    let loaded = 0;
    let total: number | null = null;

    for (;;) {
      if (options.signal?.aborted) return;
      const batch = await this.listLibraryItems(libraryId, {
        page,
        limit: pageSize,
        minified: options.minified ?? true,
        signal: options.signal,
      });
      const results = batch.results ?? [];
      if (typeof batch.total === 'number') total = batch.total;

      for (const item of results) {
        let record = absItemToBookRecord(this.serverKey, item, libraryId);
        if (!record) continue;
        if (options.enrich && !record.asin && !record.isbn) {
          record = (await this.enrichRecord(record, options.signal)) ?? record;
        }
        yield record;
      }

      loaded += results.length;
      options.onProgress?.(loaded, total);

      if (results.length < pageSize) return;
      if (total !== null && loaded >= total) return;
      page++;
    }
  }

  /** Fetches the full item to recover identifiers minified payloads omit. */
  private async enrichRecord(record: BookRecord, signal?: AbortSignal): Promise<BookRecord | null> {
    try {
      const full = await this.getLibraryItem(record.itemId, signal);
      const enriched = absItemToBookRecord(this.serverKey, full, record.libraryId);
      return enriched ? { ...enriched, key: record.key } : null;
    } catch {
      // Enrichment is best-effort; matching still works on title/author/duration.
      return null;
    }
  }

  async getLibraryItem(itemId: string, signal?: AbortSignal): Promise<AbsLibraryItem> {
    const item = await this.requestJson<AbsLibraryItem>(
      'GET',
      `/api/items/${encodeURIComponent(itemId)}`,
      { query: { expanded: 1 }, signal },
    );
    if (!item?.id) {
      throw new AbsProtocolError(`Item ${itemId} not found`, { serverUrl: this.baseUrl });
    }
    return item;
  }

  async listSeries(
    libraryId: string,
    options: { page?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<AbsPagedSeries> {
    const payload = await this.requestJson<AbsPagedSeries>(
      'GET',
      `/api/libraries/${encodeURIComponent(libraryId)}/series`,
      {
        query: { page: options.page ?? 0, limit: options.limit ?? 100 },
        signal: options.signal,
      },
    );
    return payload ?? { results: [], total: 0 };
  }

  async *iterateSeries(
    libraryId: string,
    options: { pageSize?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<AbsSeries> {
    const pageSize = options.pageSize ?? 100;
    let page = 0;
    for (;;) {
      if (options.signal?.aborted) return;
      const batch = await this.listSeries(libraryId, {
        page,
        limit: pageSize,
        signal: options.signal,
      });
      const results = batch.results ?? [];
      for (const series of results) if (series?.name) yield series;
      if (results.length < pageSize) return;
      if (typeof batch.total === 'number' && (page + 1) * pageSize >= batch.total) return;
      page++;
    }
  }

  /** Relative path to an item cover. Proxy this server-side; do not expose the token. */
  coverPath(itemId: string): string {
    return `/api/items/${encodeURIComponent(itemId)}/cover`;
  }

  async fetchCover(itemId: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.rawFetch('GET', this.coverPath(itemId), { signal, stream: true });
    await this.assertOk(response, 'GET', this.coverPath(itemId));
    return response;
  }

  // ----------------------------------------------------------------- transfer

  private downloadPaths(itemId: string, libraryId?: string): Array<{ template: 'item' | 'library'; path: string }> {
    const item = { template: 'item' as const, path: `/api/items/${encodeURIComponent(itemId)}/download` };
    const library = libraryId
      ? {
          template: 'library' as const,
          path: `/api/libraries/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(itemId)}/download`,
        }
      : null;

    // Honour whichever shape this server already accepted.
    if (this.downloadTemplate === 'library' && library) return [library, item];
    if (this.downloadTemplate === 'item') return library ? [item, library] : [item];
    return library ? [item, library] : [item];
  }

  /**
   * Opens a streaming download for an item. Multi-file items come back as a zip.
   * The response body is NOT buffered — the caller must consume or cancel it.
   */
  async openDownload(
    itemId: string,
    options: { libraryId?: string; signal?: AbortSignal } = {},
  ): Promise<DownloadHandle> {
    const candidates = this.downloadPaths(itemId, options.libraryId);
    let lastError: unknown = null;

    for (const candidate of candidates) {
      const response = await this.rawFetch('GET', candidate.path, {
        signal: options.signal,
        stream: true,
        headers: { accept: '*/*' },
      });

      if (response.status === 404 || response.status === 405) {
        // Wrong URL shape for this server version; drain and try the next.
        await response.body?.cancel().catch(() => undefined);
        lastError = new AbsHttpError({
          status: response.status,
          statusText: response.statusText,
          method: 'GET',
          path: candidate.path,
          serverUrl: this.baseUrl,
        });
        continue;
      }

      try {
        await this.assertOk(response, 'GET', candidate.path);
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }

      if (!response.body) {
        throw new AbsProtocolError(`Download of ${itemId} returned an empty body`, {
          serverUrl: this.baseUrl,
        });
      }

      this.downloadTemplate = candidate.template;
      const lengthHeader = response.headers.get('content-length');
      return {
        stream: response.body,
        contentLength: lengthHeader ? Number(lengthHeader) : null,
        contentType: response.headers.get('content-type'),
        filename: filenameFromDisposition(response.headers.get('content-disposition')) ?? `${itemId}.zip`,
        endpoint: candidate.path,
      };
    }

    throw lastError instanceof Error
      ? lastError
      : new AbsProtocolError(`No download endpoint accepted item ${itemId}`, { serverUrl: this.baseUrl });
  }

  /**
   * Enumerates the individual files that make up an item.
   *
   * Transferring these one by one is strongly preferable to `openDownload`,
   * which zips multi-file items — Audiobookshelf cannot ingest a zip as audio,
   * so a zip round-trip would create a broken item on the receiving server.
   */
  async listItemFiles(itemId: string, signal?: AbortSignal): Promise<AbsItemFile[]> {
    return (await this.listItemFilesDetailed(itemId, signal)).files;
  }

  /**
   * As `listItemFiles`, but also reports the inconsistencies found between
   * `libraryFiles` and `media.*`.
   *
   * `libraryFiles` is the authority here, not a hint: the file endpoints resolve
   * an ino by searching `libraryFiles`, so an ino that appears only under
   * `media.audioFiles` yields a 404 no matter which URL shape is used. Real
   * servers do carry such entries — a remount that changes inode numbers leaves
   * `media.audioFiles` holding both the old and new ino for every file, so the
   * item reports twice as many audio files (and twice the duration) as it has.
   * Trusting `media.*` for inos therefore queues transfers that cannot succeed.
   */
  async listItemFilesDetailed(itemId: string, signal?: AbortSignal): Promise<ItemFileListing> {
    const item = await this.getLibraryItem(itemId, signal);
    const libraryFiles = item.libraryFiles ?? [];

    /** Keyed by ino, which is how a file is addressed for download. */
    const files = new Map<string, AbsItemFile>();
    /** Names already accounted for, used to tell a stale ino from a new file. */
    const namesSeen = new Set<string>();

    const nameOf = (metadata: { filename?: string; relPath?: string } | undefined): string =>
      (metadata?.relPath ?? metadata?.filename ?? '').replace(/^\/+/, '');

    const kindOf = (fileType: string | undefined): AbsFileKind => {
      const type = (fileType ?? '').toLowerCase();
      if (type === 'audio') return 'audio';
      if (type === 'ebook') return 'ebook';
      if (type === 'image') return 'image';
      return 'other';
    };

    for (const file of libraryFiles) {
      const ino = file.ino;
      const filename = file.metadata?.filename;
      if (!ino || !filename) continue;
      files.set(String(ino), {
        ino: String(ino),
        filename,
        size: file.metadata?.size ?? 0,
        kind: kindOf(file.fileType),
      });
      namesSeen.add(nameOf(file.metadata));
    }

    const mediaAudio = item.media?.audioFiles ?? item.media?.tracks ?? [];
    let staleDuplicates = 0;
    const unfetchableAudio: string[] = [];

    for (const audio of mediaAudio) {
      const ino = audio.ino ? String(audio.ino) : '';
      const filename = audio.metadata?.filename;
      if (!filename) continue;
      const name = nameOf(audio.metadata);

      const known = ino ? files.get(ino) : undefined;
      if (known) {
        // media.* knows this is audio where libraryFiles may have said "other".
        if (known.kind === 'other') files.set(ino, { ...known, kind: 'audio' });
        continue;
      }

      if (libraryFiles.length === 0) {
        // No libraryFiles at all (older or minified responses): media.* is all
        // we have, so trust it.
        if (!ino) continue;
        files.set(ino, { ino, filename, size: audio.metadata?.size ?? 0, kind: 'audio' });
        namesSeen.add(name);
        continue;
      }

      if (namesSeen.has(name)) staleDuplicates++;
      else unfetchableAudio.push(filename);
    }

    const ebook = item.media?.ebookFile;
    if (ebook?.ino) {
      const ino = String(ebook.ino);
      const known = files.get(ino);
      if (known) {
        if (known.kind === 'other') files.set(ino, { ...known, kind: 'ebook' });
      } else if (libraryFiles.length === 0 && ebook.metadata?.filename) {
        files.set(ino, {
          ino,
          filename: ebook.metadata.filename,
          size: ebook.metadata.size ?? 0,
          kind: 'ebook',
        });
      }
    }

    return { files: [...files.values()], staleDuplicates, unfetchableAudio };
  }

  /** Opens a streaming download for a single file inside an item. */
  async openFileDownload(
    itemId: string,
    fileIno: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<DownloadHandle> {
    const base = `/api/items/${encodeURIComponent(itemId)}/file/${encodeURIComponent(fileIno)}`;
    // `/download` forces an attachment; the bare path streams. Try both, since
    // availability varies by server version.
    const candidates = [`${base}/download`, base];
    let lastError: unknown = null;

    for (const path of candidates) {
      const response = await this.rawFetch('GET', path, {
        signal: options.signal,
        stream: true,
        headers: { accept: '*/*' },
      });

      if (response.status === 404 || response.status === 405) {
        await response.body?.cancel().catch(() => undefined);
        lastError = new AbsHttpError({
          status: response.status,
          statusText: response.statusText,
          method: 'GET',
          path,
          serverUrl: this.baseUrl,
        });
        continue;
      }

      try {
        await this.assertOk(response, 'GET', path);
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }

      if (!response.body) {
        throw new AbsProtocolError(`Download of file ${fileIno} returned an empty body`, {
          serverUrl: this.baseUrl,
        });
      }

      const lengthHeader = response.headers.get('content-length');
      return {
        stream: response.body,
        contentLength: lengthHeader ? Number(lengthHeader) : null,
        contentType: response.headers.get('content-type'),
        filename: filenameFromDisposition(response.headers.get('content-disposition')) ?? fileIno,
        endpoint: path,
      };
    }

    throw lastError instanceof Error
      ? lastError
      : new AbsProtocolError(`No file endpoint accepted ${fileIno}`, { serverUrl: this.baseUrl });
  }

  /**
   * Uploads files as a new library item. Streams the multipart body so memory
   * use stays flat regardless of item size.
   */
  async upload(request: UploadRequest): Promise<AbsUploadResponse> {
    if (request.files.length === 0) {
      throw new AbsProtocolError('Upload requires at least one file', { serverUrl: this.baseUrl });
    }

    const parts: MultipartPart[] = [
      { kind: 'field', name: 'library', value: request.libraryId },
      { kind: 'field', name: 'folder', value: request.folderId },
      { kind: 'field', name: 'title', value: request.title },
    ];
    if (request.author) parts.push({ kind: 'field', name: 'author', value: request.author });
    if (request.series) parts.push({ kind: 'field', name: 'series', value: request.series });

    request.files.forEach((file, index) => {
      parts.push({
        kind: 'file',
        // ABS reads uploaded files from numerically-named fields.
        name: String(index),
        filename: file.filename,
        size: file.size,
        contentType: file.contentType ?? guessContentType(file.filename),
        open: file.open,
      });
    });

    const body = buildMultipartBody(parts, { onProgress: request.onProgress });

    const response = this.uploadTransport
      ? await this.sendUpload(this.uploadTransport, body, request.signal)
      : // Fallback for hosts with nothing but fetch. Deliberately no
        // Content-Length: it is a forbidden header for fetch, so the body goes
        // out chunked, which busboy on the ABS side handles fine. Memory grows
        // with the body here — see {@link UploadTransport}.
        await this.rawFetch('POST', '/api/upload', {
          body: body.stream,
          headers: { 'content-type': body.contentType },
          signal: request.signal,
          stream: true,
        });
    await this.assertOk(response, 'POST', '/api/upload');
    return await this.parseUploadResponse(response);
  }

  /**
   * Reads an upload's answer, which is not necessarily JSON.
   *
   * Audiobookshelf 2.x ends its upload route with `res.sendStatus(200)`, so a
   * perfectly successful upload of a gigabyte of audio answers with the plain
   * text `OK`. Insisting on JSON here turned every success into "malformed
   * JSON", which the worker treated as a failed transfer and retried — sending
   * the same audiobook three times over. A 2xx is the success signal; the body
   * is a bonus that, when present, names the item that was created.
   */
  private async parseUploadResponse(response: Response): Promise<AbsUploadResponse> {
    const text = (await response.text()).trim();
    if (!text || !/^[[{]/.test(text)) return { success: true };
    try {
      return JSON.parse(text) as AbsUploadResponse;
    } catch {
      // Shaped like JSON but broken. The upload still succeeded; the only loss
      // is the new item's id, which the next index run picks up anyway.
      return { success: true };
    }
  }

  /** Runs an injected upload transport, mapping failures onto AbsConnectionError. */
  private async sendUpload(
    transport: UploadTransport,
    body: MultipartBody,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const headers = await this.requestHeaders({ 'content-type': body.contentType });
    try {
      return await transport({
        url: this.url('/api/upload'),
        headers,
        body: body.stream,
        contentLength: body.contentLength,
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      // A caller-initiated abort must propagate unchanged so cancellation works.
      if (signal?.aborted && cause instanceof Error && cause.name === 'AbortError') throw cause;
      throw new AbsConnectionError(
        `Could not upload to ${this.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { serverUrl: this.baseUrl, cause },
      );
    }
  }

  // ----------------------------------------------------------------- playback

  /** Creates a playback session, yielding streamable track URLs. */
  async play(
    itemId: string,
    options: {
      episodeId?: string;
      deviceName?: string;
      clientName?: string;
      forceDirectPlay?: boolean;
      forceTranscode?: boolean;
      supportedMimeTypes?: string[];
      signal?: AbortSignal;
    } = {},
  ): Promise<AbsPlaybackSession> {
    const path = options.episodeId
      ? `/api/items/${encodeURIComponent(itemId)}/play/${encodeURIComponent(options.episodeId)}`
      : `/api/items/${encodeURIComponent(itemId)}/play`;

    const session = await this.requestJson<AbsPlaybackSession>('POST', path, {
      body: {
        deviceInfo: {
          clientName: options.clientName ?? 'abs-sync',
          clientVersion: '0.1.0',
          deviceName: options.deviceName ?? 'abs-sync',
        },
        supportedMimeTypes: options.supportedMimeTypes ?? [
          'audio/flac',
          'audio/mpeg',
          'audio/mp4',
          'audio/aac',
          'audio/ogg',
        ],
        mediaPlayer: 'abs-sync',
        forceDirectPlay: options.forceDirectPlay ?? false,
        forceTranscode: options.forceTranscode ?? false,
      },
      signal: options.signal,
    });

    if (!session) {
      throw new AbsProtocolError(`Playback session for ${itemId} returned no data`, {
        serverUrl: this.baseUrl,
      });
    }
    return session;
  }

  /** Reports listening progress back to the owning server. */
  async updateProgress(
    itemId: string,
    progress: { currentTime?: number; duration?: number; progress?: number; isFinished?: boolean },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.requestJson('PATCH', `/api/me/progress/${encodeURIComponent(itemId)}`, {
      body: progress,
      signal,
    });
  }

  /** Absolute URL for a track path returned by `play()`. */
  absoluteUrl(relativePath: string): string {
    return this.url(relativePath);
  }
}

/**
 * The timestamp corresponding to a given sort key. Deliberately exact: falling
 * back to a different field would make a correctly-sorted page look unsorted.
 */
function timestampFor(item: AbsLibraryItem, sortField: string): number | null {
  const raw =
    sortField === 'mtimeMs'
      ? item.mtimeMs
      : sortField === 'addedAt'
        ? item.addedAt
        : sortField === 'birthtimeMs'
          ? item.birthtimeMs
          : item.updatedAt;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** Which BookRecord field a sort key maps to, for baseline lookups. */
export function recordStampFor(record: BookRecord, sortField: string): number | null {
  const raw =
    sortField === 'mtimeMs'
      ? record.mtimeMs
      : sortField === 'addedAt'
        ? record.addedAt
        : record.updatedAt;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * Names the proxy from its error page, so the message points at the box that
 * actually needs reconfiguring. Falls back to a generic phrase.
 */
function describeProxy(bodySnippet: string): string {
  const match = /(nginx\/[\d.]+|nginx|Apache\/[\d.]+|Apache|caddy|traefik|cloudflare)/i.exec(bodySnippet);
  return match ? `A proxy (${match[1]}) in front of this server` : 'Something in front of this server';
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      // Fall through to the plain form.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() ?? null;
}

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  wav: 'audio/wav',
  zip: 'application/zip',
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  m4p: 'audio/mp4',
  webm: 'audio/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export function guessContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
