/**
 * Streaming multipart/form-data builder.
 *
 * `FormData` + `fetch` would buffer an entire audiobook in memory, which is a
 * non-starter for multi-gigabyte items. This builds the body as a lazy
 * ReadableStream instead, so bytes flow disk -> socket with a small constant
 * footprint. Deliberately free of node: imports so the package stays usable
 * from React Native and the browser.
 */

export interface MultipartFieldPart {
  kind: 'field';
  name: string;
  value: string;
}

export interface MultipartFilePart {
  kind: 'file';
  /** Form field name. ABS expects files under numeric names: "0", "1", … */
  name: string;
  filename: string;
  contentType?: string;
  /** Byte length, required so we can advertise an accurate Content-Length. */
  size: number;
  /** Called lazily when this part's bytes are needed. */
  open: () => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
}

export type MultipartPart = MultipartFieldPart | MultipartFilePart;

export interface MultipartBody {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  /** Exact total byte length of the encoded body. */
  contentLength: number;
}

const CRLF = '\r\n';

function escapeName(value: string): string {
  // RFC 7578 §5.1: escape quotes and strip CR/LF from header parameters.
  return value.replace(/"/g, '%22').replace(/[\r\n]/g, ' ');
}

function fieldHeader(boundary: string, part: MultipartFieldPart): string {
  return (
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${escapeName(part.name)}"${CRLF}${CRLF}`
  );
}

function fileHeader(boundary: string, part: MultipartFilePart): string {
  return (
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${escapeName(part.name)}"; ` +
    `filename="${escapeName(part.filename)}"${CRLF}` +
    `Content-Type: ${part.contentType || 'application/octet-stream'}${CRLF}${CRLF}`
  );
}

export function generateBoundary(): string {
  let out = '----AbsSyncBoundary';
  for (let i = 0; i < 24; i++) {
    out += Math.floor(Math.random() * 36).toString(36);
  }
  return out;
}

/**
 * Builds the multipart body. `onProgress` reports cumulative *file* bytes read
 * (not header overhead), which is what a transfer UI wants to show.
 */
export function buildMultipartBody(
  parts: readonly MultipartPart[],
  options: { boundary?: string; onProgress?: (bytesSent: number) => void } = {},
): MultipartBody {
  const boundary = options.boundary ?? generateBoundary();
  const encoder = new TextEncoder();

  const closing = encoder.encode(`--${boundary}--${CRLF}`);
  let contentLength = closing.byteLength;
  for (const part of parts) {
    if (part.kind === 'field') {
      contentLength += encoder.encode(fieldHeader(boundary, part)).byteLength;
      contentLength += encoder.encode(part.value).byteLength;
      contentLength += encoder.encode(CRLF).byteLength;
    } else {
      contentLength += encoder.encode(fileHeader(boundary, part)).byteLength;
      contentLength += part.size;
      contentLength += encoder.encode(CRLF).byteLength;
    }
  }

  let index = 0;
  let current: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let fileBytesSent = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Drain the in-flight file part first.
      if (current) {
        const { done, value } = await current.read();
        if (done) {
          current = null;
          controller.enqueue(encoder.encode(CRLF));
          return;
        }
        fileBytesSent += value.byteLength;
        options.onProgress?.(fileBytesSent);
        controller.enqueue(value);
        return;
      }

      if (index >= parts.length) {
        controller.enqueue(closing);
        controller.close();
        return;
      }

      const part = parts[index++]!;
      if (part.kind === 'field') {
        controller.enqueue(encoder.encode(fieldHeader(boundary, part)));
        controller.enqueue(encoder.encode(part.value));
        controller.enqueue(encoder.encode(CRLF));
        return;
      }

      controller.enqueue(encoder.encode(fileHeader(boundary, part)));
      const source = await part.open();
      current = source.getReader();
    },
    async cancel(reason) {
      await current?.cancel(reason).catch(() => undefined);
      current = null;
    },
  });

  return { stream, contentType: `multipart/form-data; boundary=${boundary}`, contentLength };
}
