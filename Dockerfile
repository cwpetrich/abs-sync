# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv

# The skip above: BuildKit flags any ENV named like a secret, and the build
# stage below sets a fixed ABS_SYNC_SECRET placeholder that never reaches the
# final image. Parser directives have to be the first lines in the file and
# contiguous, which is why the explanation is down here.

# abs-sync in a container.
#
# The app is a long-running service, not just a web UI — `instrumentation.ts`
# starts a transfer worker and a watch scheduler on boot — so this image is the
# containerised equivalent of the pm2 setup in `ecosystem.config.cjs`: build
# once, run the built server under a supervisor that restarts it.
#
# Two things must survive a `docker compose down`, and both live under /data:
# the SQLite database, and the spool directory holding partially transferred
# audiobooks that a retry would otherwise have to download again.

ARG NODE_IMAGE=node:24-bookworm-slim

# --------------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# --------------------------------------------------------------------- deps
# Every workspace's dependencies, dev included — `next build` needs TypeScript,
# Tailwind and the Next compiler.
FROM base AS deps

# better-sqlite3 is a native addon. npm normally downloads a prebuilt binary for
# the running Node ABI, but when there isn't one for this platform the fallback
# is a source build, and without a toolchain that fails deep inside an npm log
# rather than here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Only the manifests, so `npm ci` re-runs when dependencies change rather than
# when any source file does.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/abs-client/package.json packages/abs-client/package.json
RUN --mount=type=cache,target=/root/.npm npm ci

# -------------------------------------------------------------------- build
FROM deps AS build
COPY . .

# `next build` imports `lib/db.ts`, which constructs the Prisma client at module
# scope and so calls `getEnv()` — which throws unless the two environment-only
# settings are present. The build never opens the database or decrypts anything;
# it just needs the values to exist. These belong to this stage alone and are
# not carried into the runtime image.
ENV ABS_SYNC_SECRET="placeholder-used-only-while-building-never-at-runtime" \
    DATABASE_URL="file:/tmp/build-placeholder.db"

# The generated client is written to apps/web/generated/prisma, which is
# gitignored, so it has to be produced here rather than copied in.
RUN cd apps/web && npx prisma generate
RUN npm run build

# ------------------------------------------------------------------- pruned
# The source tree without any node_modules, so the runtime image can take source
# from here and dependencies from prod-deps without the dev tree leaking in.
#
# The source is kept, not discarded: the operator scripts (`npm run diagnose`,
# `notify:keys`, `requeue`, …) are run with tsx against `apps/web/lib`, and
# `next start` reads `next.config.ts` at boot.
FROM build AS pruned
RUN rm -rf node_modules apps/web/node_modules packages/*/node_modules

# ---------------------------------------------------------------- prod-deps
# The runtime dependency tree. Built in the same image as the app runs in, so
# better-sqlite3's binary matches the libc and Node ABI it will be loaded under.
FROM deps AS prod-deps
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ------------------------------------------------------------------- runner
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Absolute paths, both under the one volume. Absolute matters for the database:
# the Prisma CLI resolves a relative `file:./x` against the schema directory
# while the better-sqlite3 adapter resolves it against the working directory, so
# `migrate deploy` and the running app would disagree about which file they mean.
ENV DATABASE_URL="file:/data/abs-sync.db" \
    ABS_SYNC_SPOOL_DIR="/data/spool"

# Created in the image so that a fresh named volume mounted here inherits this
# ownership from Docker, and the unprivileged user can write to it on first boot.
RUN install -d -o node -g node /data /data/spool

COPY --from=prod-deps --chown=node:node /app /app
COPY --from=pruned --chown=node:node /app /app
COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/abs-sync-entrypoint

USER node
EXPOSE 3000
VOLUME ["/data"]

# `/` is force-dynamic and reads the database, so a 200 means the server is up
# *and* its SQLite connection works — which a plain port check would not tell us.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/abs-sync-entrypoint"]
