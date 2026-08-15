#!/bin/sh
# Container entrypoint: check, migrate, then hand the process over to the server.
#
# `exec` at the end matters. It makes Next PID 1, so Docker's SIGTERM reaches it
# directly on `docker stop` and an in-flight upload gets the stop grace period to
# finish — the same reason `ecosystem.config.cjs` sets kill_timeout.
set -eu

# Fail here rather than three screens later. Without the secret the server still
# boots — instrumentation.ts deliberately swallows the error so the settings page
# stays reachable — but every credential read and write fails, which reads as a
# broken app rather than a missing variable.
if [ -z "${ABS_SYNC_SECRET:-}" ]; then
  cat >&2 <<'MESSAGE'
abs-sync: ABS_SYNC_SECRET is not set.

Configuration is read from apps/web/.env, which is also what the from-source
setup uses. If you have not made one yet:

    cd apps/web && cp .env.example .env
    openssl rand -base64 48        # paste into ABS_SYNC_SECRET

The secret encrypts the Audiobookshelf credentials stored in the database, so
the app cannot do anything useful without it. Keep it: changing it invalidates
every stored credential.
MESSAGE
  exit 1
fi

# The database and the spool must be on the volume, which means absolute paths.
# Sharing one .env with the from-source setup means the file legitimately carries
# `file:./dev.db`, relative to apps/web — docker-compose.yml overrides both for
# exactly that reason. This catches the case where it did not: a `docker run
# --env-file apps/web/.env` with no override, where a relative path would put the
# database in the container's writable layer and lose it on the next `docker rm`.
case "${DATABASE_URL:-}" in
  file:/*) ;;
  *)
    echo "abs-sync: DATABASE_URL is \"${DATABASE_URL:-<unset>}\", which is not an absolute file: path." >&2
    echo "  Inside the container the database has to live on the mounted volume." >&2
    echo "  Use docker compose, which sets it to file:/data/abs-sync.db, or pass" >&2
    echo "  -e DATABASE_URL=file:/data/abs-sync.db yourself." >&2
    exit 1
    ;;
esac
case "${ABS_SYNC_SPOOL_DIR:-}" in
  /*) ;;
  *)
    echo "abs-sync: ABS_SYNC_SPOOL_DIR is \"${ABS_SYNC_SPOOL_DIR:-<unset>}\", which is not an absolute path." >&2
    echo "  Downloads would be spooled into the container's writable layer and lost." >&2
    echo "  Use docker compose, or pass -e ABS_SYNC_SPOOL_DIR=/data/spool yourself." >&2
    exit 1
    ;;
esac

cd /app/apps/web

# Idempotent, and the only way a first boot gets a schema at all. Applying
# migrations on every start also means `docker compose up -d --build` after a
# `git pull` upgrades the database along with the image, with no second command
# to remember.
echo "[abs-sync] applying database migrations"
/app/node_modules/.bin/prisma migrate deploy

echo "[abs-sync] starting server on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
exec /app/node_modules/.bin/next start
