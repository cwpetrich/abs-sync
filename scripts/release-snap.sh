#!/usr/bin/env bash
# Build the snap and push it to the store.
#
# This is the whole release pipeline. There is deliberately no CI behind it:
# abs-sync is a private repository, so GitHub Actions minutes are metered, and a
# snapcraft build here is expensive — npm ci, a Next build, then a second
# npm ci --omit=dev. Running it on the machine that already has LXD warmed up
# costs nothing and takes about the same wall time.
#
# The store upload is the only part that leaves this machine, and it is free.
#
#   scripts/release-snap.sh                     build, publish to edge
#   scripts/release-snap.sh stable              build, publish to stable
#   scripts/release-snap.sh --bump patch beta   0.1.0 -> 0.1.1, publish to beta
#   scripts/release-snap.sh --build-only        build, touch nothing remote
#   scripts/release-snap.sh --install           build and install it here to test
set -euo pipefail

readonly SNAP_NAME=abs-sync

usage() {
  cat <<'MESSAGE'
Usage: scripts/release-snap.sh [options] [channel]

  channel   edge | beta | candidate | stable   (default: edge)

Options:
  --bump <patch|minor|major|X.Y.Z>
                  Set the version in package.json before building. The snap
                  takes its version from there (adopt-info in snapcraft.yaml),
                  so this is how a release gets a new number.
  --build-only    Build and stop. Nothing is uploaded.
  --upload-only   Skip the build and upload the .snap already sitting here for
                  the current version. For retrying a failed upload.
  --install       Install the built snap locally (--dangerous) before uploading.
                  Wants sudo.
  --remote        Build on Launchpad's builders instead of locally, which is the
                  only way to get architectures this machine is not. See --project.
  --project <name>
                  Private Launchpad project to build in. Required with --remote:
                  without it snapcraft publishes the source publicly, and this
                  repository is private. Also read from $LAUNCHPAD_PROJECT.
  --arch <list>   Comma-separated architectures for --remote. Default: amd64,arm64.
  --incremental   Reuse the previous build's intermediate state. Faster for
                  iterating; not what you want for something you publish.
  --allow-dirty   Build with uncommitted changes in the tree.
  -y, --yes       Do not ask before uploading.
  -h, --help      This.

First time on a new machine: `snapcraft login`, and `snapcraft register abs-sync`
if the name has never been claimed.
MESSAGE
}

die() {
  echo "release-snap: $*" >&2
  exit 1
}

# ------------------------------------------------------------------ arguments
channel=edge
bump=""
build=yes
upload=yes
install_locally=no
remote=no
project="${LAUNCHPAD_PROJECT:-}"
arches=amd64,arm64
allow_dirty=no
incremental=no
assume_yes=no

while [ $# -gt 0 ]; do
  case "$1" in
    --bump)         bump="${2:?--bump needs a value}"; shift 2 ;;
    --build-only)   upload=no; shift ;;
    --upload-only)  build=no; shift ;;
    --install)      install_locally=yes; shift ;;
    --remote)       remote=yes; shift ;;
    --project)      project="${2:?--project needs a value}"; shift 2 ;;
    --arch)         arches="${2:?--arch needs a value}"; shift 2 ;;
    --incremental)  incremental=yes; shift ;;
    --allow-dirty)  allow_dirty=yes; shift ;;
    -y|--yes)       assume_yes=yes; shift ;;
    -h|--help)      usage; exit 0 ;;
    edge|beta|candidate|stable) channel="$1"; shift ;;
    -*)             usage >&2; die "unknown option \"$1\"" ;;
    *)              usage >&2; die "unknown channel \"$1\" — expected edge, beta, candidate or stable" ;;
  esac
done

[ "${build}" = yes ] || [ "${upload}" = yes ] \
  || die "--build-only and --upload-only together leave nothing to do"

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------- preconditions
command -v snapcraft >/dev/null 2>&1 \
  || die "snapcraft is not installed — sudo snap install snapcraft --classic"

# Before the build rather than before the upload. Store credentials expire, and
# discovering that after a ten-minute build is a bad way to find out.
if [ "${upload}" = yes ]; then
  snapcraft whoami >/dev/null 2>&1 \
    || die "not logged in to the store — run: snapcraft login (or --build-only)"
fi

# Checked before the bump, so the bump is the only thing that dirties the tree.
if [ "${allow_dirty}" = no ] && [ -n "$(git status --porcelain)" ]; then
  cat >&2 <<'MESSAGE'
release-snap: the working tree has uncommitted changes.

A snap built from a dirty tree ships whatever is in the tree, and its version
says nothing about which commit that was. Commit first, or pass --allow-dirty
if you know that is what you want.
MESSAGE
  exit 1
fi

if [ -n "${bump}" ]; then
  case "${bump}" in
    patch|minor|major|[0-9]*.[0-9]*.[0-9]*) ;;
    *) die "--bump wants patch, minor, major or an explicit X.Y.Z, not \"${bump}\"" ;;
  esac
  # --no-git-tag-version: committing and tagging is the operator's call, not a
  # side effect of building. The suggested commands get printed at the end.
  npm version "${bump}" --no-git-tag-version --workspaces=false >/dev/null
fi

version="$(node -p 'require("./package.json").version')"
[ -n "${version}" ] || die "could not read a version out of package.json"

echo "release-snap: ${SNAP_NAME} ${version} -> ${channel}"

# --------------------------------------------------------------------- build
if [ "${remote}" = yes ]; then
  if [ -z "${project}" ]; then
    cat >&2 <<'MESSAGE'
release-snap: --remote needs --project.

snapcraft remote-build uploads the source to Launchpad, and by default that
upload is public. This repository is private, so building without saying where
would publish it. Create a private project on Launchpad, then:

  scripts/release-snap.sh --remote --project my-private-project

Register an SSH key with Launchpad first — the source goes up over SSH.
MESSAGE
    exit 1
  fi
fi

if [ "${build}" = yes ]; then
  # Both builders drop their output in the current directory. Clear the old
  # files for this version first so a failed build cannot leave a stale snap
  # behind for the upload step to find and cheerfully publish.
  rm -f "${SNAP_NAME}_${version}_"*.snap

  if [ "${remote}" = yes ]; then
    snapcraft remote-build --project "${project}" --build-for "${arches}"
  else
    # Clean the application part first, so what gets published was built from
    # the tree as it stands and not from whatever the last run left in
    # parts/abs-sync/. Only that part: cleaning `node` too would re-download
    # and re-verify the Node tarball every release for no benefit.
    [ "${incremental}" = yes ] || snapcraft clean abs-sync
    snapcraft pack
  fi
fi

# Local builds produce one file; remote builds produce one per architecture.
snaps=()
while IFS= read -r file; do
  snaps+=("${file}")
done < <(find . -maxdepth 1 -name "${SNAP_NAME}_${version}_*.snap" -printf '%P\n' | sort)

[ "${#snaps[@]}" -gt 0 ] \
  || die "no ${SNAP_NAME}_${version}_*.snap here — build it first, or --bump to the version you meant"

for file in "${snaps[@]}"; do
  echo "release-snap: built $(du -h "${file}" | cut -f1)  ${file}"
done

# ------------------------------------------------------------ local install
if [ "${install_locally}" = yes ]; then
  arch="$(dpkg --print-architecture)"
  local_file="${SNAP_NAME}_${version}_${arch}.snap"
  [ -f "${local_file}" ] || die "--install wants ${local_file}, which this build did not produce"
  echo "release-snap: installing ${local_file} locally"
  sudo snap install --dangerous "${local_file}"
fi

if [ "${upload}" = no ]; then
  echo "release-snap: --build-only, stopping here"
  exit 0
fi

# -------------------------------------------------------------------- upload
if [ "${assume_yes}" = no ]; then
  echo
  echo "About to publish ${SNAP_NAME} ${version} to ${channel} for: ${snaps[*]}"
  [ "${channel}" = stable ] && echo "This is the channel a plain \`snap install ${SNAP_NAME}\` gets."
  printf 'Continue? [y/N] '
  read -r reply
  case "${reply}" in
    y|Y|yes|YES) ;;
    *) die "cancelled" ;;
  esac
fi

for file in "${snaps[@]}"; do
  echo "release-snap: uploading ${file}"
  if ! snapcraft upload --release="${channel}" "${file}"; then
    cat >&2 <<MESSAGE

release-snap: the upload failed.

If the store says the name is not registered, claim it once with:

  snapcraft register ${SNAP_NAME}

If it says the credentials expired, run \`snapcraft login\` again. Everything is
built already — rerun with --upload-only to retry just this step.
MESSAGE
    exit 1
  fi
done

echo
snapcraft status "${SNAP_NAME}" || true

if [ -n "${bump}" ]; then
  cat <<MESSAGE

release-snap: package.json now says ${version}, uncommitted. To record it:

  git commit package.json package-lock.json -m "Release ${version}"
  git tag "v${version}"
MESSAGE
fi
