# abs-sync

Compare Audiobookshelf libraries across servers, see what other people have that you don't, and pull
those books into your own server — by book, by author, or by a whole series that keeps itself in sync.

## How syncing actually works (read this first)

Audiobookshelf has **no server-to-server transfer API**. There is no "copy this book to that server"
call. So a sync here means:

1. Enumerate the item's individual files on the source server (`GET /api/items/:id`).
2. Download each original audio file to local disk (`GET /api/items/:id/file/:ino/download`).
3. Upload them all as one new item to your server (`POST /api/upload`).

Three consequences worth knowing up front:

- **Every synced byte flows through this app.** It needs disk space for the largest item you sync and
  bandwidth for both legs of the trip.
- **abs-sync transfers the original files, not the whole-item zip.** The `/download` endpoint zips
  multi-file items, and Audiobookshelf cannot ingest a zip as audio — importing one would create a
  broken item. If a source server won't report an item's file list, the transfer fails with a clear
  message instead of uploading something unusable.
- **`libraryFiles` is the authority on what can be downloaded**, not `media.audioFiles`. See below.
- **You need the right permissions.** Source accounts need *download*; your own server's account
  needs *upload*. The UI checks both when you add a server and tells you which one is missing.
- **Uploads deliberately do not use `fetch`.** See below.

### Uploads bypass fetch

`fetch` retains every chunk of a streamed *request* body until the request finishes, so memory grows
with the upload no matter how carefully the body is produced. Sending a 1.2 GB audiobook through it
grew the process by the full 1.2 GB; a larger item ended a dev server outright with `FATAL ERROR:
Ineffective mark-compacts near heap limit — JavaScript heap out of memory`, 649 MB into the upload.
Measured on the same 1,183 MB body, same multipart builder, same file sources:

| Transport | Peak RSS | Wall clock |
| --- | --- | --- |
| `fetch` with a `ReadableStream` body | 1,076 MB | 4.6 s |
| `fetch` with an async iterable body | 1,125 MB | 2.5 s |
| `node:http`, piped | **169 MB** | **1.1 s** |

Draining the very same body locally instead of handing it to `fetch` stays at 75 MB, which is what
rules out the multipart builder and `Readable.toWeb` as the cause.

So `AbsClient` takes an optional `uploadTransport`, and the web app injects one built on `node:http`
(`apps/web/lib/node-upload.ts`). Piping into a `ClientRequest` applies real backpressure and drops
each chunk once the socket has it. Two things follow from being off `fetch`:

- **An exact `Content-Length` goes out** instead of chunked encoding (`Content-Length` is a forbidden
  header for `fetch`), together with `Expect: 100-continue`. A size-limited proxy can then refuse the
  upload before a single byte of audio moves, rather than after receiving all of it.
- **Redirects are reported, not followed.** There is nothing to replay a one-shot stream body with, so
  a 3xx on `/api/upload` says which address to save instead of failing obscurely.

The package still falls back to `fetch` when no transport is injected, since React Native and the
browser have nothing else.

### A successful upload does not answer with JSON

Audiobookshelf ends its upload route with `res.sendStatus(200)`. A gigabyte of audio lands safely and
the body is the plain text `OK`. Insisting on JSON turned every success into "malformed JSON", which
the worker recorded as a failed transfer and **retried — re-uploading the same audiobook twice more**
after it had already arrived. A 2xx is the success signal; the body is read only if it is shaped like
JSON. The cost is that nothing names the item that was created, so `resultItemId` stays null and the
next index run is what discovers the new book.

### Which file list to trust

`GET /api/items/:id/file/:ino` resolves the ino by searching the item's **`libraryFiles`**. An ino
that appears only under `media.audioFiles` therefore 404s on every URL shape, and no amount of
endpoint fallback will save it.

This is not a theoretical distinction. On a real 2.35.1 server whose library lives on a NAS, a
remount changed the inode numbers: `media.audioFiles` kept both the old and the new ino for every
file while `libraryFiles` only had the current ones. **1,184 of that library's 1,338 items (88%)
were affected**, every one of them listing each file exactly twice. Consequences:

- Enumerating from `media.audioFiles` queues transfers that cannot succeed. Every sync from that
  server failed with `404 Not Found`.
- The item's `media.duration` and `media.size` are summed from that list, so both come back at
  **exactly twice** the real value. `item.size` comes from the filesystem scan and stays correct,
  which is why abs-sync prefers it.

So enumeration takes inos from `libraryFiles` only, and uses `media.*` purely to refine a file's
kind. Entries in `media.*` whose filename already appears in `libraryFiles` are stale duplicates and
ignored. Entries whose filename appears *nowhere* in `libraryFiles` are genuinely unfetchable, and
the transfer refuses to run rather than upload an audiobook with chapters silently missing. The
matcher separately withholds the duration signal when two copies differ by an exact whole multiple,
since that is far more likely to be this artifact than evidence of a different recording.

`npm run diagnose` samples a spread of items and several files per item, and reports how many are
affected. Checking one file of one item is not enough — the first ino in the list is usually a good
one. The real repair is on the source server: re-scanning the library rebuilds the audio file list
from what is on disk.

## Requirements

- Node.js 20.9+ (developed on 24)
- Audiobookshelf 2.26+ on any server you want to use an **API key** with (API keys landed in 2.26.0).
  Older servers still work via username/password.

## Setup

```bash
npm install

cd apps/web
cp .env.example .env
# Generate the credential-encryption secret and paste it into ABS_SYNC_SECRET:
openssl rand -base64 48

npx prisma migrate deploy
npm run dev          # http://localhost:3000
```

Then, in the UI:

1. **Servers** → add your own server, tick "This is my server". Use an API key from
   *Settings → Users → API Keys* on the Audiobookshelf side.
2. Add the servers you've been given access to.
3. Press **Index now** on each one (comparison reads only from the local index, never live).
4. **Compare** → review what's missing and press Sync, or **Auto-sync this series**.

### Running it for real

`npm run dev` is for editing code. It is the wrong way to *run* this app: the
transfer worker and watch scheduler started by `instrumentation.ts` are meant to
be up for days, and a foreground dev server dies with the shell that launched it
— sshd sends `SIGHUP` to the process group the moment the connection drops, in
the middle of whatever was transferring.

Run it under a process supervisor instead:

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save                     # restore this list on reboot
```

Reboot survival additionally needs pm2's own systemd unit and lingering, once
per machine:

```bash
pm2 startup                  # prints a sudo command; run it
sudo loginctl enable-linger "$USER"
```

Logs go to `logs/abs-sync.log` and `logs/abs-sync-error.log`, so a genuine crash
leaves something to read — a dev server in a closed terminal does not.

To work on the code while the service runs, give the dev server its own port so
it does not collide with the supervised one: `PORT=3001 npm run dev`. Both
processes share `dev.db`, and two transfer workers against one queue is not a
configuration this app is built for, so stop the pm2 instance (`pm2 stop
abs-sync`) if you are going to exercise transfers by hand.

### Configuration

All configuration is environment variables, so a container deployment stays reproducible. See
`apps/web/.env.example`; the **Settings** page shows the live values.

| Variable | Purpose |
| --- | --- |
| `ABS_SYNC_SECRET` | **Required.** Key material for encrypting stored credentials (min 32 chars). Changing it invalidates every stored credential. |
| `DATABASE_URL` | SQLite file holding servers, index, jobs and watches. |
| `ABS_SYNC_SPOOL_DIR` | Where downloads land before upload, and are kept for retries. Defaults to `apps/web/spool/` — not `/tmp`, which reboots clear. Needs room for your largest item. |
| `ABS_SYNC_MAX_CONCURRENT` | Simultaneous transfers (default 2). |
| `ABS_SYNC_WATCH_INTERVAL_MINUTES` | How often watched series are re-checked (default 60). |
| `ABS_SYNC_FULL_REINDEX_HOURS` | How stale a full reconcile may get before one is forced (default 24). |
| `ABS_SYNC_ALLOWED_ORIGINS` | Extra hostnames the app is reached by (LAN IP, machine name, proxy host). Required for Server Actions and dev assets to work off-localhost. |
| `ABS_SYNC_MATTERMOST_URL` / `_TOKEN` / `_TEAM` / `_CHANNEL` | Post through the Mattermost API as a bot or user. Preferred when set. |
| `ABS_SYNC_MATTERMOST_WEBHOOK_URL` | Incoming webhook, used when no token is set. Treat as a credential. |
| `ABS_SYNC_VAPID_PUBLIC_KEY` / `ABS_SYNC_VAPID_PRIVATE_KEY` | Browser push identity. Generate with `npm run notify:keys`. |
| `ABS_SYNC_VAPID_SUBJECT` | Contact address the push services use to reach you. |
| `ABS_SYNC_PUBLIC_URL` | Absolute URL used for links inside notifications. |
| `ABS_SYNC_NOTIFY_DIGEST_SECONDS` | Window over which routine notifications are batched (default 30). |
| `ABS_SYNC_MAX_ITEM_BYTES` | Refuse any single item larger than this (default 25 GiB). |
| `ABS_SYNC_SPOOL_KEEP_BYTES` | Downloaded audio kept for not-yet-successful transfers so retries do not re-fetch it (default 20 GiB; 0 disables). |
| `ABS_SYNC_REQUIRE_HTTPS` | Reject plain-http server URLs except localhost. |

> **There is no login.** abs-sync is a single-tenant admin tool that holds credentials for every
> server you add, and its Server Actions are reachable by direct POST. Run it on a trusted network or
> behind a reverse proxy that authenticates. Do not expose it to the internet unguarded.

## Repository layout

```
packages/core         Server-agnostic matching + diff engine (no dependencies)
packages/abs-client   Typed Audiobookshelf client, plus a mock server used by tests
apps/web              Next.js 16 app: UI, Prisma/SQLite, transfer worker, scheduler
```

Workspace packages ship TypeScript source and are compiled by Next via `transpilePackages`, so
there's no build step to keep in sync while developing.

## Indexing

Comparison reads only from a local cache of each server's metadata, so an index has to
exist first. Two modes:

- **Full** — crawls every library, then deletes anything the run did not see. This is what
  reconciles books removed upstream, since Audiobookshelf has no "what changed" feed.
- **Incremental** — asks for items newest-first and stops at the first one older than what is
  already held. One new book costs one request instead of one per hundred books.

"Index now" picks automatically: incremental when there is a usable baseline and a full
reconcile happened within `ABS_SYNC_FULL_REINDEX_HOURS` (default 24), otherwise full. It
escalates to a full crawl by itself whenever incremental cannot be trusted — a library with no
baseline, more changed pages than the budget allows, or a server that ignores the sort key.

That last case is the important one. Servers silently ignore a sort key they do not recognise,
and stopping early on an unsorted response would index a sliver of a library and report the rest
as missing. So the ordering is verified against each page *before* any early stop is applied, and
an unverifiable response falls back to a full crawl rather than being trusted. "Full re-index"
forces the full path on demand.

Two things learned from real servers (2.32.1 and 2.35.1), both of which the code now depends on:

- Audiobookshelf honours **`mtimeMs`** and **`addedAt`** as sort keys, but **not `updatedAt`** —
  that field is populated on every item and returned in no useful order. The ordering check must
  therefore validate *the field it sorted by*; reading a preferred field instead rejects perfectly
  good responses. Keys are tried in order (`mtimeMs`, then `addedAt`, then `updatedAt`), the
  working one is remembered per server, and each candidate is compared against its own baseline
  column — which is why all three timestamps are stored per item.
- `addedAt` only moves when a book is *added*, so on a server where that is the only usable key,
  metadata-only edits are picked up by the periodic full reconcile rather than incrementally.

Measured on a 1,338-book library: a full crawl is 14 requests and ~3.5s; an incremental pass with
nothing new is 1 request and ~0.2s.

## How books are matched

Deciding "do I already own this?" is the whole ballgame — a false positive hides a book you want, and
a false negative fills your library with duplicates. The engine (`packages/core`) works in tiers:

1. **ASIN**, then **ISBN** (ISBN-10 is converted to ISBN-13 so the two forms compare equal).
2. **Title similarity** — normalized for diacritics, articles, punctuation and edition noise
   ("Unabridged", "Dramatized Adaptation", "A Novel"), compared across title variants so one server
   carrying the subtitle and another not still matches, and so "Alice in Wonderland" lines up with
   "Alice's Adventures in Wonderland". Variants that collapse to the same string are compared once,
   which matters because a single comparison costs several edit-distance passes.
3. **Author similarity**, tolerant of `"Last, First"` ordering and of servers disagreeing about how to
   split a name.
4. **Duration proximity**, which separates abridged from unabridged recordings — except when the
   two durations differ by an exact whole multiple, which is the signature of a server double-counting
   its audio files rather than a different recording. There the signal is withheld instead of scored.

Two deliberate hard rejections, both there to prevent silent data loss:

- **Volume numbers never merge.** "Sword of Destiny, Part 1" and "Part 2" are near-identical on every
  other signal. Numbering is normalized (`Book II`, `Book 2`, `Book Two` all become the same token)
  and *preserved*, never stripped.
- **Conflicting series positions never merge**, so #1 and #2 of a series can't collapse into one.

Anything scoring between "probably" and "definitely" is reported as a **possible duplicate** rather
than as missing, and is never auto-queued by a watch — unattended automation should not risk
duplicating someone's library.

## Why the compare page streams

The diff is pure — it reads only the local index, never the network — but it is not cheap: on a
1,338-book source library it costs about 3 seconds, nearly all of it edit-distance scoring while
clustering copies of the same work across servers. Two consequences were handled explicitly:

- **The page renders as a static shell with independent Suspense boundaries.** Awaiting the diff
  before rendering anything meant a click on "Compare" sat there doing nothing for seconds and looked
  broken. Now the header and the filter controls appear immediately and the results stream in behind
  them.
- **The diff yields to the event loop as it runs** (`diffAgainstTargetAsync`). This is the part that
  actually made streaming work, and it is worth being precise about: Suspense boundaries alone changed
  nothing, because a tight synchronous loop on a single-threaded server leaves no thread to deliver
  the fallback with. Measured in production mode, response *headers* did not arrive for 3.3s — the
  process was simply blocked, unable to flush the shell, serve any other route, or write transfer
  progress. Yielding every 25 items costs a fraction of a percent and fixed all of it: first byte
  dropped from 3.30s to 0.34s, and other routes kept answering in ~0.19s while the diff ran.
- **The diff is cached, keyed by a fingerprint of the indexed rows it read** (row count plus the
  newest `seenAt`, which moves on any add, removal or re-index). Without it, every filter change,
  every search keystroke and every background refresh paid the full cost again. Filters, search and
  grouping are applied on top of the cached diff, so they drop from ~3s to ~40ms.

Relatedly, the background auto-refresh used while indexing or transferring now runs inside a
transition and skips a tick while one is still in flight. `router.refresh()` clears the client cache
for the current route, so a route slower than the poll interval accumulated overlapping refreshes
that also competed with any navigation the user had started — which could restart a slow page load
indefinitely so it never arrived.

## Watched series

Marking a series watched means: on every scheduled pass, re-index the watched servers, then queue
anything in that series your server lacks. Safeguards:

- If your server has **no index**, evaluation is skipped rather than queueing the entire series.
- Only clear misses are queued; possible duplicates are logged for you to review.
- Jobs are deduplicated **by work**, not just by source item — so syncing a book from one friend and
  then having a watch fire before your next re-index won't queue the same book again from someone
  else.

## Notifications

Once this runs unattended, the interesting events happen while you are asleep: a watch pulls six
books at 4am and one of them fails on a proxy limit. Two transports carry that out, and both are
optional — with neither configured nothing is sent and nothing errors.

- **Mattermost**, which needs no HTTPS on this end and whose mobile app gives you phone push without
  abs-sync knowing anything about phones. Two ways in, and the API is used whenever a token is set:

  | | API token | Incoming webhook |
  | --- | --- | --- |
  | Configured by | server + team + **channel name** | an opaque URL |
  | Setup | create a bot, add it to the channel | create a webhook |
  | Reach if leaked | anything that account can do | posting to one channel |
  | Several channels | one token covers all | one webhook each |
  | Server has webhooks disabled | works | unavailable |

  The API path resolves the channel name to an id once and caches it — an id is what the posts
  endpoint wants, and it appears nowhere in the Mattermost UI, so it is not something a human can
  reasonably be asked to configure. The failure everyone hits is a 403 on the first post: **adding a
  bot to a team does not add it to any channels**, and Mattermost's own error says only
  "permissions". abs-sync says which channel and what to do about it.
- **Browser push (Web Push)**, which arrives with abs-sync closed. Generate a VAPID keypair with
  `npm run notify:keys`, then enable it per device from **Settings**.

Browser push needs the app served over **HTTPS** — both the Push API and the Notification API are
secure-context only, so on a plain-http LAN address the Settings panel reports it as unavailable
rather than offering a button that cannot work. Terminating TLS at a reverse proxy in front of the
app is enough; the app itself does not need a certificate. On **iOS**, push additionally requires
the site be installed to the Home Screen first — which is what `app/manifest.ts` exists for.

### Volume is the whole design

Everything notable already flows through `logActivity`, so that is the only place notifications are
raised from: no call site has to remember to notify, and anything added later is covered for free.
The difficulty is not delivery, it is restraint. One real watch pass wrote twenty activity lines —
seven "auto-queued", seven "synced", and a warning for each source item with a duplicated file list.
Twenty pushes for one pass is how a channel gets muted, and a muted channel is worse than none
because it still looks like it is working. So:

- **Failures notify immediately.** They are rare and time-sensitive.
- **Everything else is batched** into one message per `ABS_SYNC_NOTIFY_DIGEST_SECONDS`. The window is
  *tumbling*, measured from the first buffered event rather than extended by later ones — a sliding
  window lets a long transfer run postpone its own digest indefinitely, which is exactly when you
  want to hear something.
- **Routine indexing is dropped entirely.** An hourly "indexed 0 new books" per server is not news,
  and it would otherwise be the overwhelming majority of the traffic.
- **A digest takes the worst level in the batch**, so a failure is never softened into an info-level
  message by the good news around it.

That pass of seven books becomes two notifications instead of fourteen.

Delivery never touches the operation being reported. Notifications are raised after the activity row
is written and are deliberately not awaited, so a webhook pointed at a dead host cannot add its
timeout to a transfer's critical path; transports fail independently, so Mattermost being down does
not cost you the push to your phone. A subscription is only deleted when a push service answers 404
or 410 — the signal that the browser genuinely threw it away. Dropping one on a 5xx or a timeout
would silently unsubscribe a device because the push service had a bad afternoon.

## Verification

```bash
npm test          # 169 tests across the three workspaces
npm run typecheck
npm run build
```

The web app's suite is a real integration test: three mock Audiobookshelf servers (one of them on
username/password auth), driven through registration, indexing, comparison, an actual byte-for-byte
file transfer, and a watch that queues and transfers the rest of a series. `globalThis.fetch` is
routed to the mocks by hostname, so the app's own client code runs unmodified. The mock server is
exported from `@abs-sync/abs-client/mock-server` if you want to reuse it.

`test/node-upload.test.ts` runs against a real local HTTP server instead, because the things the
upload transport exists for cannot be mocked: it asserts that a 256 MB body grows the process by less
than 64 MB (through `fetch` the same test grows it by 270 MB), that the `Content-Length` matches the
bytes that arrive, that a proxy refusing at the `100-continue` handshake sends no audio at all, and
that cancelling aborts the request.

## Diagnosing real servers

```bash
cd apps/web && npm run diagnose        # every enabled server
npm run diagnose -- friend             # just matching names
```

Three narrower read-only tools sit alongside it:

```bash
npm run scan:files -- jarom                 # every item: does media.audioFiles match libraryFiles?
npm run preflight -- jarom <itemId>         # can every file this item would transfer be fetched?
npm run probe:file -- jarom <itemId>        # raw endpoint shapes and file lists for one item
npm run find -- "spell or high water"       # which servers have this book, with size and file count
```

`find` is how you confirm what an upload actually created — including whether a retried transfer left
a duplicate item behind.

`preflight` is the quickest way to confirm a failing transfer: it enumerates exactly as the worker
does, opens each file's download, and cancels it once the headers arrive.

Read-only. `diagnose` reports credential encryption (including grepping the raw SQLite file for the
plaintext to prove it is not recoverable), auth and permissions, library and upload-folder
discovery, the indexer's paging path with real metadata mapping, whether ASIN/ISBN survive
minified listings, whether incremental indexing is supported, file enumeration, both download URL
shapes, and playback session creation. Credentials come from the encrypted database, never from
arguments, so they stay out of your shell history. Exits non-zero on any failure.

## One book, one row

A single book can accumulate several transfer rows: a watch queues it, it is cancelled, someone syncs
it again from a different friend's server, it fails and is retried. Left alone that turns the
Transfers page into a list where the same title appears four times and "which one do I retry?" has no
answer. Two things keep it to one row per book:

- **Asking again revives the previous attempt.** When a transfer is requested for a book whose earlier
  attempt is `failed` or `canceled`, that row is reset to `queued` rather than a new one being
  inserted — carrying its retained download with it, so the retry uploads what is already on disk.
  (Live attempts still short-circuit as duplicates, as before.)
- **The page groups by book identity**, using the normalized title and author already stored on each
  job. The row shows the attempt that matters — running, then queued, then completed, then the most
  recent failure — and the rest collapse behind "show earlier attempts". A book that *did* arrive
  reads as completed even if a stray later attempt was cancelled, so you are never sent
  re-transferring something you already have.

**Retry acts on whichever attempt still holds the audio**, which is not always the newest one: a row
cancelled before it downloaded anything can sit above one holding the whole audiobook. The row says
so — "download kept, a retry uploads it without fetching again".

## Downloads are not repeated

A transfer that fails at the upload step still has perfectly good audio on disk, and re-fetching an
entire audiobook to hand the receiving server the same bytes is pure waste — the more so when the
source is a friend's server on someone else's bandwidth. So the spool survives anything that might
yet be retried:

- **Complete files are reused.** Before fetching, each file is checked against the size the source
  reports. An exact match is reused; anything else — a partial write from an interrupted attempt — is
  fetched again. A file with no reported size is never reused, because there is nothing to verify it
  against. This is what stops a truncated chapter reaching the receiving server.
- **Spool files are named by ino**, not by position in the file list, so a source that gains or loses
  a file does not invalidate everything already downloaded. Files no longer in the item's listing are
  discarded at the start of each attempt.
- **A crash keeps its progress.** Recovery requeues interrupted transfers without deleting their
  spool; the one file that was mid-write fails verification and is re-fetched while the rest are not.
  Measured by hard-killing the server mid-transfer: **671 MB of 1.1 GB was reused** across two books,
  27 of 40 files and 26 of 42.
- **Retention is bounded.** `ABS_SYNC_SPOOL_KEEP_BYTES` (default 20 GiB) caps how much is held for
  transfers that have not succeeded, evicting the longest-idle failed job first. The budget is
  re-checked every few minutes while running, not only at startup.
- **The spool does not live in `/tmp`.** It defaults to `apps/web/spool/` (gitignored). `/tmp` is
  cleared on reboot on most Linux systems — fine when the spool was scratch space, wrong now that it
  is a cache meant to outlive a restart. Override with `ABS_SYNC_SPOOL_DIR`.

Downloaded audio is discarded in exactly three cases: the transfer **succeeded**, it was
**cancelled**, or the job was **cleared from the Transfers list** — clearing a failed transfer is the
act of discarding its cache, so the UI reports how much disk that freed. Nothing else deletes it, and
a failure of any kind keeps it. Verified against a real server: re-running a failed transfer logged
`Reused 40 of 40 already-downloaded file(s) (562 MB not fetched again)` and issued no download
requests at all.

## Operational gotchas

- **The transfer worker and watch scheduler do not hot-reload.** They are singletons created once
  from `instrumentation.ts` and held on `globalThis`, so `next dev` recompiling a module does *not*
  rebuild them. After changing `lib/sync-worker.ts`, `lib/indexer.ts`, or anything they import,
  restart the dev server — otherwise transfers keep running the old code, which is easy to mistake for
  the fix not working. **Restart before requeueing**, not after: a queued job is picked up within
  seconds, and a whole audiobook can be uploaded on the old code while you are still typing.
- **Uploads go through whatever sits in front of the receiving server.** nginx defaults
  `client_max_body_size` to 1 MB, so every audiobook upload is rejected with a 413 until that is
  raised. abs-sync names the proxy from its error page and treats the failure as permanent rather
  than re-downloading the whole book to fail again. The proxy needs:

  ```nginx
  client_max_body_size 0;          # or a generous ceiling
  proxy_request_buffering off;     # stream through instead of buffering to disk
  proxy_read_timeout 3600s;
  client_body_timeout 3600s;
  ```

- **A permanently failed transfer is re-queued by the next watch pass.** `failed` is not treated as a
  live job, so a book that cannot transfer is retried on every scheduled run. That is what you want
  for a transient outage and wasteful for a persistent one — pause the watch until the cause is
  fixed.

## Status and next steps

The web app is complete, verified end to end against mock servers, and has now moved real books
between two real servers: three audiobooks (2.2 GB, 185 files) downloaded from a friend's 2.35.1
server and uploaded to another, with every landed file matching the source byte count exactly.

Two endpoint shapes still vary between Audiobookshelf versions, and the client probes both at
runtime, remembering whichever works: item download (`/api/items/:id/download` vs
`/api/libraries/:lid/items/:id/download`) and per-file download (`/file/:ino/download` vs
`/file/:ino`). Minified library listings also omit ASIN/ISBN on some versions — pass `enrich` to
backfill them at the cost of one request per item.

One thing remains:

- **The React Native app** (multi-server login, one merged catalog, series-continuous playback across
  servers) is the next phase. It reuses `packages/core` and `packages/abs-client` unchanged; the
  client is deliberately free of Node built-ins so it bundles for iOS, Android and the browser, and
  its playback-session and progress-reporting methods are already implemented and covered by tests.
