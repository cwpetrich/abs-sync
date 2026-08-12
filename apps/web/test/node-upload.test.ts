import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AbsClient, AbsPayloadTooLargeError } from '@abs-sync/abs-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeUploadTransport } from '../lib/node-upload';

/**
 * Exercises the upload transport against a real HTTP server, which is the whole
 * point of it existing: `fetch` retains every chunk of a streamed request body,
 * so a multi-gigabyte audiobook exhausts the heap mid-upload. These cover the
 * wire-level behaviour a mocked `fetch` cannot — flat memory, an exact
 * Content-Length, refusal before the body, and abort.
 */

interface Capture {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  bytes: number;
  body: Buffer;
}

interface Harness {
  server: Server;
  baseUrl: string;
  captures: Capture[];
  /** Set to refuse the upload at the 100-continue handshake, like nginx's 413. */
  rejectWith: { status: number; body: string } | null;
  /** Set to have the server read the body slowly. */
  drainDelayMs: number;
  /** Set to discard the body instead of keeping it, for large-payload tests. */
  discardBody: boolean;
}

async function startHarness(): Promise<Harness> {
  // Handlers read through this object, so a test can change its mind after the
  // server is up; spreading it into the return value would hand back a copy.
  const state = {
    captures: [] as Capture[],
    rejectWith: null as { status: number; body: string } | null,
    drainDelayMs: 0,
    discardBody: false,
  } as Harness;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('error', () => undefined);
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (!state.discardBody) chunks.push(chunk);
      if (state.drainDelayMs > 0) {
        req.pause();
        setTimeout(() => req.resume(), state.drainDelayMs);
      }
    });
    req.on('end', () => {
      state.captures.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        bytes,
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, libraryItem: { id: 'li_new' } }));
    });
  };

  const server = createServer(handle);
  // With a checkContinue listener the server decides whether to invite the body,
  // which is exactly what a size-limited proxy in front of ABS does.
  server.on('checkContinue', (req, res) => {
    if (state.rejectWith) {
      res.writeHead(state.rejectWith.status, { 'content-type': 'text/html', connection: 'close' });
      res.end(state.rejectWith.body);
      return;
    }
    res.writeContinue();
    handle(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.server = server;
  state.baseUrl = `http://127.0.0.1:${port}`;
  return state;
}

/** A file source that yields the given chunks, once. */
function streamOf(chunks: string[]): () => ReadableStream<Uint8Array> {
  return () => {
    const remaining = [...chunks];
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = remaining.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    });
  };
}

/** A file source of `count` freshly allocated chunks, for memory measurement. */
function largeStream(count: number, chunkBytes: number): () => ReadableStream<Uint8Array> {
  return () => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= count) {
          controller.close();
          return;
        }
        // A fresh allocation each time: reusing one buffer would make retention
        // free and hide the very leak this measures.
        controller.enqueue(new Uint8Array(chunkBytes).fill(sent % 251));
      },
    });
  };
}

describe('node upload transport', () => {
  let harness: Harness;
  let client: AbsClient;

  beforeEach(async () => {
    harness = await startHarness();
    client = new AbsClient({
      baseUrl: harness.baseUrl,
      auth: { kind: 'apiKey', apiKey: 'key-123' },
      uploadTransport: nodeUploadTransport,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  });

  it('streams the multipart body with an exact Content-Length', async () => {
    const result = await client.upload({
      libraryId: 'lib-1',
      folderId: 'fol-1',
      title: 'Spell or High Water',
      author: 'Scott Meyer',
      files: [
        { filename: 'part-01.mp3', size: 12, open: streamOf(['AAAA', 'BBBB', 'CCCC']) },
        { filename: 'part-02.mp3', size: 8, open: streamOf(['DDDD', 'EEEE']) },
      ],
    });

    expect(result.libraryItem?.id).toBe('li_new');
    const capture = harness.captures.at(0);
    expect(capture?.url).toBe('/api/upload');
    expect(capture?.headers.authorization).toBe('Bearer key-123');
    // The fetch path could not send one at all (forbidden header), so the body
    // went out chunked; the exact figure is what lets a proxy refuse early.
    expect(Number(capture?.headers['content-length'])).toBe(capture?.bytes);

    const text = capture?.body.toString() ?? '';
    expect(text).toContain('name="library"');
    expect(text).toContain('lib-1');
    expect(text).toContain('filename="part-01.mp3"');
    expect(text).toContain('AAAABBBBCCCC');
    expect(text).toContain('DDDDEEEE');
    expect(text).toContain('Scott Meyer');
  });

  it('holds memory flat while sending a body far larger than the heap allowance', async () => {
    harness.discardBody = true;
    const chunkBytes = 64 * 1024;
    const chunks = 4096; // 256 MB
    const collect = (globalThis as { gc?: () => void }).gc;
    collect?.();
    const before = process.memoryUsage();
    let peakGrowth = 0;
    let samples = 0;

    await client.upload({
      libraryId: 'lib-1',
      folderId: 'fol-1',
      title: 'Large',
      files: [
        { filename: 'part-01.mp3', size: chunks * chunkBytes, open: largeStream(chunks, chunkBytes) },
      ],
      onProgress: () => {
        // Every 32 MB: collect first, so what is left is what is really held.
        if (++samples % 512 !== 0) return;
        collect?.();
        const now = process.memoryUsage();
        const growth = now.heapUsed + now.external - (before.heapUsed + before.external);
        peakGrowth = Math.max(peakGrowth, growth);
      },
    });

    expect(harness.captures.at(0)?.bytes).toBeGreaterThan(chunks * chunkBytes);
    // Sending this through fetch grew the process by the full 256 MB. Anything
    // near that means the body is being retained again.
    expect(peakGrowth).toBeLessThan(64 * 1024 * 1024);
  });

  it('reports progress as file bytes leave, and only file bytes', async () => {
    const seen: number[] = [];
    await client.upload({
      libraryId: 'lib-1',
      folderId: 'fol-1',
      title: 'Fight and Flight',
      files: [{ filename: 'part-01.mp3', size: 12, open: streamOf(['AAAA', 'BBBB', 'CCCC']) }],
      onProgress: (bytesSent) => seen.push(bytesSent),
    });

    expect(seen.at(-1)).toBe(12);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('surfaces a proxy rejection as AbsPayloadTooLargeError before sending anything', async () => {
    harness.rejectWith = {
      status: 413,
      body:
        '<html><head><title>413 Request Entity Too Large</title></head><body>' +
        '<center><h1>413 Request Entity Too Large</h1></center><hr><center>nginx/1.24.0</center></body></html>',
    };

    let sent = 0;
    const attempt = client.upload({
      libraryId: 'lib-1',
      folderId: 'fol-1',
      title: 'Too Big',
      files: [
        {
          filename: 'part-01.mp3',
          size: 512 * 1024,
          open: largeStream(512, 1024),
        },
      ],
      onProgress: (bytesSent) => {
        sent = bytesSent;
      },
    });

    await expect(attempt).rejects.toThrow(AbsPayloadTooLargeError);
    await expect(attempt).rejects.toThrow(/nginx\/1\.24\.0/);
    await expect(attempt).rejects.toThrow(/client_max_body_size/);
    // Refused at the 100-continue handshake: not one byte of audio went out.
    expect(sent).toBe(0);
  });

  it('propagates an abort so cancelling a transfer stops the upload', async () => {
    harness.drainDelayMs = 5;
    const controller = new AbortController();
    const attempt = client.upload({
      libraryId: 'lib-1',
      folderId: 'fol-1',
      title: 'Canceled',
      files: [{ filename: 'part-01.mp3', size: 256 * 1024, open: largeStream(256, 1024) }],
      onProgress: (bytesSent) => {
        if (bytesSent > 4096) controller.abort();
      },
      signal: controller.signal,
    });

    await expect(attempt).rejects.toThrow(/abort/i);
    expect(harness.captures).toHaveLength(0);
  });
});
