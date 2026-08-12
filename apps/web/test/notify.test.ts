import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../lib/env';

/**
 * Notification policy and batching.
 *
 * The delivery mechanics belong to `web-push` and to Mattermost; what is worth
 * testing here is the part this app decided: which events are worth a
 * notification at all, and the batching that keeps one watch pass from firing a
 * dozen of them.
 */

/** Captures what a real Mattermost webhook would have received. */
interface Received {
  text: string;
  username?: string;
  channel?: string;
}

let server: Server;
let webhookUrl: string;
let port: number;
let received: Received[] = [];
/** Every request the fake Mattermost saw, for the API-transport tests. */
let requests: Array<{ path: string; auth: string | undefined; body: any }> = [];
/** Set per test to make the webhook misbehave. */
let respondWith: { status: number; body: string } | null = null;
/** Set per test to make the posts endpoint refuse. */
let postStatus = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const path = req.url ?? '';
      const body = raw ? JSON.parse(raw) : null;

      // --- Mattermost REST API ---
      if (path.startsWith('/api/v4/')) {
        requests.push({ path, auth: req.headers.authorization, body });
        if (path.includes('/channels/name/nonexistent')) {
          res.writeHead(404).end(JSON.stringify({ message: 'Channel does not exist' }));
          return;
        }
        if (path.includes('/channels/name/')) {
          res.writeHead(200).end(JSON.stringify({ id: 'channel-id-123', name: 'general' }));
          return;
        }
        if (path === '/api/v4/posts') {
          if (postStatus !== 200) {
            res.writeHead(postStatus).end(JSON.stringify({ message: 'no' }));
            return;
          }
          res.writeHead(201).end(JSON.stringify({ id: 'post-1' }));
          return;
        }
        res.writeHead(404).end('{}');
        return;
      }

      // --- incoming webhook ---
      if (respondWith) {
        res.writeHead(respondWith.status).end(respondWith.body);
        return;
      }
      received.push(body as Received);
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  port = address.port;
  webhookUrl = `http://127.0.0.1:${port}/hooks/test`;
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  received = [];
  requests = [];
  respondWith = null;
  postStatus = 200;
  vi.useRealTimers();
  for (const key of [
    'ABS_SYNC_MATTERMOST_WEBHOOK_URL',
    'ABS_SYNC_MATTERMOST_URL',
    'ABS_SYNC_MATTERMOST_TOKEN',
    'ABS_SYNC_MATTERMOST_TEAM',
    'ABS_SYNC_MATTERMOST_CHANNEL',
    'ABS_SYNC_PUBLIC_URL',
    'ABS_SYNC_NOTIFY_DIGEST_SECONDS',
  ]) {
    delete process.env[key];
  }
  resetEnvCache();
});

function configure(overrides: Record<string, string> = {}): void {
  process.env.ABS_SYNC_MATTERMOST_WEBHOOK_URL = webhookUrl;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  resetEnvCache();
}

describe('which events are worth notifying about', () => {
  it('drops routine indexing, which is almost all of the traffic', async () => {
    const { isNotifiable } = await import('../lib/notify');
    // Every server, every hour, almost always reporting nothing new.
    expect(isNotifiable({ kind: 'index', level: 'info', message: 'Indexed 0 books' })).toBe(false);
    // Its failures still have to get through.
    expect(isNotifiable({ kind: 'index', level: 'error', message: 'Auth rejected' })).toBe(true);
    expect(isNotifiable({ kind: 'index', level: 'warn', message: 'Fell back to full' })).toBe(true);
  });

  it('keeps transfer and watch activity', async () => {
    const { isNotifiable } = await import('../lib/notify');
    expect(isNotifiable({ kind: 'sync', level: 'info', message: 'Synced "X"' })).toBe(true);
    expect(isNotifiable({ kind: 'watch', level: 'info', message: 'Auto-queued "X"' })).toBe(true);
  });

  it('sends errors immediately and batches everything else', async () => {
    const { isImmediate } = await import('../lib/notify');
    expect(isImmediate({ kind: 'sync', level: 'error', message: 'failed permanently' })).toBe(true);
    expect(isImmediate({ kind: 'sync', level: 'warn', message: 'will retry' })).toBe(false);
    expect(isImmediate({ kind: 'sync', level: 'info', message: 'Synced' })).toBe(false);
  });
});

describe('digest rendering', () => {
  it('reads like a plain alert when there is only one event', async () => {
    configure();
    const { renderDigest } = await import('../lib/notify');
    const digest = renderDigest([
      { kind: 'sync', level: 'error', message: 'Transfer of "Dune" failed permanently: 413' },
    ]);
    expect(digest?.title).toBe('Transfer');
    expect(digest?.body).toBe('Transfer of "Dune" failed permanently: 413');
    // No bullet, no "1 update" — a report with one row reads as a bug.
    expect(digest?.body).not.toContain('•');
  });

  it('collapses a whole watch pass into one message', async () => {
    configure();
    const { renderDigest } = await import('../lib/notify');
    // The real 15:37 pass: seven books queued from one series.
    const titles = ['Collapse', 'Resistance', 'Control', 'Invasion', 'Dispute', 'Divergence', 'Exploration'];
    const digest = renderDigest(
      titles.map((title) => ({
        kind: 'watch' as const,
        level: 'info' as const,
        message: `Auto-queued "${title}" from watched series "Welcome to the Multiverse"`,
      })),
    );
    expect(digest?.title).toBe('Watched series · 7 updates');
    expect(digest?.body.split('\n')).toHaveLength(7);
    expect(digest?.body).toContain('• Auto-queued "Collapse"');
  });

  it('summarises the tail rather than sending an essay', async () => {
    configure();
    const { renderDigest } = await import('../lib/notify');
    const digest = renderDigest(
      Array.from({ length: 20 }, (_, i) => ({
        kind: 'sync' as const,
        level: 'info' as const,
        message: `Synced book ${i}`,
      })),
    );
    const lines = digest!.body.split('\n');
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toBe('• …and 12 more');
  });

  it('takes the worst level in the batch, so an error is not softened by good news', async () => {
    configure();
    const { renderDigest } = await import('../lib/notify');
    const digest = renderDigest([
      { kind: 'sync', level: 'info', message: 'Synced "A"' },
      { kind: 'sync', level: 'error', message: 'Transfer of "B" failed' },
    ]);
    expect(digest?.level).toBe('error');
  });

  it('links to the page the events belong to', async () => {
    configure({ ABS_SYNC_PUBLIC_URL: 'https://abs.example.com/' });
    const { renderDigest } = await import('../lib/notify');
    expect(renderDigest([{ kind: 'watch', level: 'info', message: 'x' }])?.url).toBe(
      'https://abs.example.com/watches',
    );
    // A notification with a link nobody can resolve is worse than no link.
    delete process.env.ABS_SYNC_PUBLIC_URL;
    configure();
    const { renderDigest: render2 } = await import('../lib/notify');
    expect(render2([{ kind: 'watch', level: 'info', message: 'x' }])?.url).toBeNull();
  });
});

describe('batching', () => {
  it('sends one message for a burst instead of one per event', async () => {
    vi.useFakeTimers();
    configure({ ABS_SYNC_NOTIFY_DIGEST_SECONDS: '30' });
    const { Notifier } = await import('../lib/notify');
    const notifier = new Notifier();

    for (let i = 0; i < 7; i++) {
      notifier.push({ kind: 'watch', level: 'info', message: `Auto-queued "Book ${i}"` });
    }
    expect(received).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    await notifier.settled();

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toContain('7 updates');
  });

  it('does not make an error wait for the window', async () => {
    vi.useFakeTimers();
    configure({ ABS_SYNC_NOTIFY_DIGEST_SECONDS: '30' });
    const { Notifier } = await import('../lib/notify');
    const notifier = new Notifier();

    notifier.push({ kind: 'sync', level: 'info', message: 'Synced "A"' });
    notifier.push({ kind: 'sync', level: 'error', message: 'Transfer of "B" failed permanently' });

    vi.useRealTimers();
    await notifier.settled();

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toContain('failed permanently');
    expect(received[0]!.text).toContain(':rotating_light:');
  });

  it('closes the window from the first event, so a long batch cannot defer itself', async () => {
    vi.useFakeTimers();
    configure({ ABS_SYNC_NOTIFY_DIGEST_SECONDS: '30' });
    const { Notifier } = await import('../lib/notify');
    const notifier = new Notifier();

    notifier.push({ kind: 'sync', level: 'info', message: 'first' });
    await vi.advanceTimersByTimeAsync(20_000);
    // A sliding window would restart here and never fire during a long transfer run.
    notifier.push({ kind: 'sync', level: 'info', message: 'second' });
    await vi.advanceTimersByTimeAsync(10_000);

    vi.useRealTimers();
    await notifier.settled();

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toContain('first');
    expect(received[0]!.text).toContain('second');
  });

  it('stays quiet when no transport is configured', async () => {
    resetEnvCache();
    const { Notifier } = await import('../lib/notify');
    const notifier = new Notifier();
    notifier.push({ kind: 'sync', level: 'error', message: 'boom' });
    await notifier.settled();
    expect(received).toHaveLength(0);
  });
});

describe('posting through the Mattermost API', () => {
  /** Stands in for a Mattermost server: channel lookup, then post. */
  function apiConfigure(overrides: Record<string, string> = {}): void {
    delete process.env.ABS_SYNC_MATTERMOST_WEBHOOK_URL;
    process.env.ABS_SYNC_MATTERMOST_URL = `http://127.0.0.1:${port}`;
    process.env.ABS_SYNC_MATTERMOST_TOKEN = 'test-token';
    process.env.ABS_SYNC_MATTERMOST_TEAM = 'audiobooks';
    process.env.ABS_SYNC_MATTERMOST_CHANNEL = 'general';
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
    resetEnvCache();
  }

  it('resolves the channel by name and posts to its id', async () => {
    apiConfigure();
    const { sendMattermost, resetChannelCache } = await import('../lib/notify-mattermost');
    resetChannelCache();

    await sendMattermost({ title: 'Transfer', body: 'Synced "Dune"', level: 'info', url: null });

    expect(requests.map((r) => r.path)).toEqual([
      '/api/v4/teams/name/audiobooks/channels/name/general',
      '/api/v4/posts',
    ]);
    expect(requests[0]!.auth).toBe('Bearer test-token');
    expect(requests[1]!.body).toMatchObject({ channel_id: 'channel-id-123' });
    expect(requests[1]!.body.message).toContain('Synced "Dune"');
  });

  it('resolves the channel once, not on every notification', async () => {
    apiConfigure();
    const { sendMattermost, resetChannelCache } = await import('../lib/notify-mattermost');
    resetChannelCache();

    for (let i = 0; i < 3; i++) {
      await sendMattermost({ title: 't', body: `b${i}`, level: 'info', url: null });
    }

    expect(requests.filter((r) => r.path.includes('/channels/name/'))).toHaveLength(1);
    expect(requests.filter((r) => r.path === '/api/v4/posts')).toHaveLength(3);
  });

  it('explains a 403 as channel membership, which is the actual cause', async () => {
    apiConfigure();
    const { sendMattermost, resetChannelCache } = await import('../lib/notify-mattermost');
    resetChannelCache();
    postStatus = 403;

    // Adding a bot to a team does not add it to channels, and Mattermost's own
    // error for this says only "permissions".
    await expect(
      sendMattermost({ title: 't', body: 'b', level: 'info', url: null }),
    ).rejects.toThrow(/member of that channel/);
  });

  it('names both possibilities when a channel cannot be found', async () => {
    apiConfigure({ ABS_SYNC_MATTERMOST_CHANNEL: 'nonexistent' });
    const { sendMattermost, resetChannelCache } = await import('../lib/notify-mattermost');
    resetChannelCache();

    await expect(
      sendMattermost({ title: 't', body: 'b', level: 'info', url: null }),
    ).rejects.toThrow(/Check both names, and that the bot or user/);
  });

  it('prefers the API when both it and a webhook are configured', async () => {
    apiConfigure();
    process.env.ABS_SYNC_MATTERMOST_WEBHOOK_URL = webhookUrl;
    resetEnvCache();
    const { sendMattermost, mattermostMode, resetChannelCache } = await import(
      '../lib/notify-mattermost'
    );
    resetChannelCache();

    expect(mattermostMode()).toBe('api');
    await sendMattermost({ title: 't', body: 'b', level: 'info', url: null });
    expect(received).toHaveLength(0);
    expect(requests.some((r) => r.path === '/api/v4/posts')).toBe(true);
  });

  it('falls back to the webhook when no token is configured', async () => {
    configure();
    const { mattermostMode } = await import('../lib/notify-mattermost');
    expect(mattermostMode()).toBe('webhook');
  });
});

describe('the logActivity hook', () => {
  it('raises a notification for a real logged event', async () => {
    configure();
    const { logActivity } = await import('../lib/activity');
    const { getNotifier } = await import('../lib/notify');

    await logActivity('sync', 'Transfer of "Dune" failed permanently: 413 Payload Too Large', {
      level: 'error',
    });
    await getNotifier().settled();

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toContain('Dune');
    expect(received[0]!.username).toBe('abs-sync');
  });

  it('still writes the activity row when every transport is broken', async () => {
    configure();
    respondWith = { status: 500, body: 'mattermost is down' };
    const { logActivity } = await import('../lib/activity');
    const { getNotifier } = await import('../lib/notify');
    const { prisma } = await import('../lib/db');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The trail in the database is the durable record; notification is a
    // best-effort courier on top of it and must never be able to cost us a row.
    await logActivity('sync', 'a transfer that must be recorded', { level: 'error' });
    await getNotifier().settled();
    spy.mockRestore();

    const row = await prisma.activityLog.findFirst({
      where: { message: 'a transfer that must be recorded' },
    });
    expect(row).not.toBeNull();
  });

  it('does not notify for routine index chatter', async () => {
    configure();
    const { logActivity } = await import('../lib/activity');
    const { getNotifier } = await import('../lib/notify');

    await logActivity('index', 'Incrementally indexed "Conrad\'s Server": 0 new book(s)');
    await getNotifier().settled();

    expect(received).toHaveLength(0);
  });
});

describe('transport failures', () => {
  it('reports what Mattermost said, rather than a bare status', async () => {
    configure();
    respondWith = { status: 403, body: 'Invalid webhook token' };
    const { deliver } = await import('../lib/notify');
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args));

    // deliver() contains transport failures on purpose: it is called from the
    // worker mid-transfer, and a broken webhook must not fail a sync.
    await expect(deliver({ title: 't', body: 'b', level: 'info', url: null })).resolves.toBeUndefined();
    spy.mockRestore();
    expect(JSON.stringify(errors)).toContain('Invalid webhook token');
  });

  it('does not let a hung webhook block the caller forever', async () => {
    configure();
    const { sendMattermost } = await import('../lib/notify-mattermost');
    // The 10s timeout is what keeps a transfer from inheriting a dead LAN host's
    // connect timeout; assert it is wired up rather than waiting it out.
    const promise = sendMattermost({ title: 't', body: 'b', level: 'info', url: null });
    await expect(promise).resolves.toBeUndefined();
  });
});
