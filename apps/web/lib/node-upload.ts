import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UploadTransport, UploadTransportRequest } from '@abs-sync/abs-client';

/**
 * Streams an upload with `node:http` instead of `fetch`.
 *
 * `fetch` retains every chunk of a streamed request body until the request
 * finishes: uploading a 1.2 GB audiobook grew the process by 1.1 GB, and a
 * multi-gigabyte item killed it outright with "JavaScript heap out of memory"
 * mid-upload. The same body written through `node:http` holds flat (measured:
 * 1076 MB peak RSS via fetch vs 169 MB here, and four times faster), because
 * piping a stream into a ClientRequest applies real backpressure and drops each
 * chunk once the socket has it.
 *
 * Sending an exact Content-Length is the other half of the win: it replaces
 * chunked encoding, which fetch forces (Content-Length is a forbidden header
 * there), and it lets a reverse proxy reject an oversized body up front rather
 * than after receiving all of it.
 */

/**
 * How long the socket may sit idle before the upload is abandoned. Generous:
 * once the body is sent, Audiobookshelf scans and moves the files before
 * answering, and that is silent time on the wire.
 */
const IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * How long to wait for a `100 Continue` before sending the body anyway. The
 * Expect header lets nginx answer "413 too large" before we push gigabytes at
 * it, but a proxy that ignores Expect must not stall the transfer.
 */
const CONTINUE_TIMEOUT_MS = 5_000;

let override: UploadTransport | null = null;

/**
 * Test hook: routes uploads somewhere other than a socket. The integration
 * suite points every server at an in-memory mock by swapping global `fetch`,
 * which this transport deliberately bypasses; without a seam those tests would
 * try to reach `mock.abs.test` for real. Pass null to restore.
 */
export function setUploadTransportOverride(next: UploadTransport | null): void {
  override = next;
}

export const nodeUploadTransport: UploadTransport = (options) =>
  (override ?? sendUpload)(options);

function sendUpload(options: UploadTransportRequest): Promise<Response> {
  const url = new URL(options.url);
  const send = url.protocol === 'http:' ? httpRequest : httpsRequest;

  return new Promise<Response>((resolve, reject) => {
    const req = send({
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        ...options.headers,
        'content-length': String(options.contentLength),
        expect: '100-continue',
      },
    });

    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      run();
    };

    let bodyStarted = false;
    const startBody = (): void => {
      if (bodyStarted || settled) return;
      bodyStarted = true;
      // `pipeline` ends the request for us and destroys it if the source fails.
      pipeline(Readable.fromWeb(options.body as never), req).catch((error: unknown) => {
        // An early rejection (413) destroys the request mid-body; that is the
        // response's story to tell, so only surface this if nothing else has.
        finish(() => reject(error));
      });
    };

    const continueTimer = setTimeout(startBody, CONTINUE_TIMEOUT_MS);
    req.on('continue', () => {
      clearTimeout(continueTimer);
      startBody();
    });

    req.setTimeout(IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`upload stalled: no activity for ${IDLE_TIMEOUT_MS / 60_000} minutes`));
    });

    req.on('response', (res) => {
      clearTimeout(continueTimer);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        // fetch used to follow this silently, which cannot work for a one-shot
        // stream body: there is nothing left to replay. Always a misconfigured
        // server URL, so say so.
        finish(() =>
          reject(
            new Error(
              `the server answered POST /api/upload with ${status} redirect to ${location} — ` +
                'change the saved server URL to that address',
            ),
          ),
        );
        req.destroy();
        return;
      }
      // Read the answer before hanging up: a rejection's body is what identifies
      // the rejecter (nginx's 413 page, say). Hanging up then stops the rest of
      // the audiobook from being pushed at a server that has stopped listening.
      finish(() => resolve(collectResponse(res).finally(() => req.destroy())));
    });

    req.on('error', (error) => {
      clearTimeout(continueTimer);
      finish(() => reject(error));
    });

    if (options.signal) {
      const { signal } = options;
      const abort = (): void => {
        req.destroy(abortError());
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      // Both outcomes clear the listener; the request object is discarded after.
      req.on('close', () => signal.removeEventListener('abort', abort));
    }
  });
}

function abortError(): Error {
  const error = new Error('The upload was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Buffers the response into a `Response`, so callers can use the same error
 * handling as the fetch path. Safe to buffer: Audiobookshelf answers an upload
 * with a small JSON object, and a proxy with a short HTML error page.
 */
async function collectResponse(res: IncomingMessage): Promise<Response> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const MAX_BODY_BYTES = 256 * 1024;
  for await (const chunk of res) {
    if (bytes >= MAX_BODY_BYTES) continue;
    bytes += (chunk as Buffer).byteLength;
    chunks.push(chunk as Buffer);
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) headers.append(name, single);
  }

  const status = res.statusCode ?? 502;
  const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
  return new Response(body, {
    status,
    statusText: res.statusMessage ?? '',
    headers,
  });
}
