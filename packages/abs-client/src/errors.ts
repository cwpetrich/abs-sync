export class AbsError extends Error {
  readonly serverUrl: string | undefined;

  constructor(message: string, options: { serverUrl?: string; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AbsError';
    this.serverUrl = options.serverUrl;
  }
}

/** Non-2xx response from the server. */
export class AbsHttpError extends AbsError {
  readonly status: number;
  readonly statusText: string;
  readonly method: string;
  readonly path: string;
  readonly bodySnippet: string;

  constructor(init: {
    status: number;
    statusText: string;
    method: string;
    path: string;
    bodySnippet?: string;
    serverUrl?: string;
  }) {
    super(
      `${init.method} ${init.path} failed: ${init.status} ${init.statusText}${
        init.bodySnippet ? ` — ${init.bodySnippet}` : ''
      }`,
      { serverUrl: init.serverUrl },
    );
    this.name = 'AbsHttpError';
    this.status = init.status;
    this.statusText = init.statusText;
    this.method = init.method;
    this.path = init.path;
    this.bodySnippet = init.bodySnippet ?? '';
  }

  /** True for statuses where retrying with the same input can plausibly work. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 408 || (this.status >= 500 && this.status <= 599);
  }
}

/** Credentials were rejected, or the token/API key expired. */
export class AbsAuthError extends AbsError {
  constructor(message: string, options: { serverUrl?: string; cause?: unknown } = {}) {
    super(message, options);
    this.name = 'AbsAuthError';
  }
}

/** The server is unreachable, TLS failed, or the request timed out. */
export class AbsConnectionError extends AbsError {
  constructor(message: string, options: { serverUrl?: string; cause?: unknown } = {}) {
    super(message, options);
    this.name = 'AbsConnectionError';
  }
}

/** The server responded, but not in a shape we can use. */
export class AbsProtocolError extends AbsError {
  constructor(message: string, options: { serverUrl?: string; cause?: unknown } = {}) {
    super(message, options);
    this.name = 'AbsProtocolError';
  }
}

/**
 * The request body was refused as too large, almost always by a reverse proxy in
 * front of Audiobookshelf.
 *
 * Its own class because this outcome is *deterministic*: resending identical
 * bytes cannot succeed. A transfer that retries it just re-downloads the whole
 * audiobook to fail the same way, so callers should treat it as permanent and
 * stop rather than burn their retry budget.
 */
export class AbsPayloadTooLargeError extends AbsProtocolError {
  constructor(message: string, options: { serverUrl?: string; cause?: unknown } = {}) {
    super(message, options);
    this.name = 'AbsPayloadTooLargeError';
  }
}
