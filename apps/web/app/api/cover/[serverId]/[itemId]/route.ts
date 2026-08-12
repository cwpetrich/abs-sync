import { prisma } from '../../../../../lib/db';
import { clientFor } from '../../../../../lib/servers';

/**
 * Proxies cover art from a source server.
 *
 * Covers are fetched server-side so the Audiobookshelf credential never reaches
 * the browser. Params are Promises in Next 16.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ serverId: string; itemId: string }> },
) {
  const { serverId, itemId } = await context.params;

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) {
    return new Response('Unknown server', { status: 404 });
  }

  try {
    const upstream = await clientFor(server).fetchCover(itemId);
    if (!upstream.body) return new Response('No cover', { status: 404 });

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
        // Covers are effectively immutable per item; cache hard in the browser.
        'cache-control': 'private, max-age=86400',
      },
    });
  } catch {
    // A missing cover is routine — many items have none. Keep it quiet.
    return new Response('Cover unavailable', { status: 404 });
  }
}
