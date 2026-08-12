# @abs-sync/web

The abs-sync web app. See the [repository README](../../README.md) for setup, configuration and how
matching works.

```bash
cp .env.example .env     # then fill in ABS_SYNC_SECRET
npx prisma migrate deploy
npm run dev              # http://localhost:3000

npm test                 # integration suite against mock Audiobookshelf servers
npm run typecheck
npm run build
```

Layout:

| Path | What lives there |
| --- | --- |
| `app/` | Routes, UI components, and the Server Actions in `app/actions.ts` |
| `lib/` | Server-only logic: servers, indexer, compare, transfer worker, watches, scheduler |
| `prisma/` | Schema and migrations; the client generates to `generated/prisma` |
| `test/` | Integration suite plus the fetch router that points the app at mock servers |

`instrumentation.ts` starts the transfer worker and the watch scheduler when the server boots.
