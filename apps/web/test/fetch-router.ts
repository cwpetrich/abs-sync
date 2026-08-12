import type { MockAbsServer } from '@abs-sync/abs-client/mock-server';
import { setUploadTransportOverride } from '../lib/node-upload';

/**
 * Routes global `fetch` to registered mock Audiobookshelf servers by origin.
 *
 * The app builds its own clients internally (via `clientFor`), so there is no
 * seam to inject a fetch implementation. Swapping the global instead means the
 * integration tests exercise the real code path end to end.
 *
 * Uploads need one extra redirect: they go through `node:http` rather than
 * `fetch` (see lib/node-upload.ts), so they are pointed back at the mock here.
 * The socket-level behaviour that transport exists for is covered separately in
 * node-upload.test.ts, against a real HTTP server.
 */
export function installFetchRouter() {
  const original = globalThis.fetch;
  const registry = new Map<string, MockAbsServer>();

  setUploadTransportOverride((request) =>
    globalThis.fetch(request.url, {
      method: 'POST',
      headers: { ...request.headers, 'content-length': String(request.contentLength) },
      body: request.body,
      ...(request.signal ? { signal: request.signal } : {}),
      duplex: 'half',
    } as RequestInit),
  );

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const origin = new URL(href).origin;
    const server = registry.get(origin);
    if (!server) {
      throw new TypeError(`fetch failed: no mock server registered for ${origin}`);
    }
    return server.fetch(input, init);
  }) as typeof fetch;

  return {
    register(server: MockAbsServer) {
      registry.set(new URL(server.baseUrl).origin, server);
      return server;
    },
    restore() {
      globalThis.fetch = original;
      setUploadTransportOverride(null);
      registry.clear();
    },
  };
}
