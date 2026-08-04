#!/bin/sh
# Build soms:latest — the app image (FROM soms-base, compiling the server FROM soms-build-base). If
# either local base is missing, this script builds it first. Refresh the runtime/Caddy base with
# ./scripts/build-base.sh and the native compilation base with ./scripts/build-build-base.sh.
#   ./scripts/build-image.sh
#
# Network: proxy variables are forwarded verbatim from the invoking environment. --network=host also
# permits a build container to reach a system proxy bound to the host loopback; no proxy address or
# port is defined here. NODE_IMAGE overrides the compile-stage base if Docker Hub is unreachable.
set -e
export DOCKER_BUILDKIT=1

VER=$(node -p "require('./package.json').version")
NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"

# Auto-build either base if it is missing. Both scripts inherit NODE_IMAGE, PULL, and proxy vars.
if ! docker image inspect soms-base:latest >/dev/null 2>&1; then
  echo "soms-base:latest not found locally — building it first (./scripts/build-base.sh)…"
  "$(dirname "$0")"/build-base.sh
fi
if ! docker image inspect soms-build-base:latest >/dev/null 2>&1; then
  echo "soms-build-base:latest not found locally — building it first (./scripts/build-build-base.sh)…"
  "$(dirname "$0")"/build-build-base.sh
fi

echo "building soms:$VER (FROM soms-base:latest, also tagged latest) — app…"
# No signing secret: the web bundle is integrity-checked by SHA-256 + TLS (https), not signed.
# shellcheck disable=SC2086
# No --pull: soms-base:latest is LOCAL (built by build-base.sh) — --pull would try the registry and
# 403 (soms-base isn't published). The node base for the compile stages is already local/cached.
docker build --network=host \
  --build-arg APP_VERSION="$VER" \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg SOMS_BASE=soms-base:latest \
  --build-arg SOMS_BUILD_BASE=soms-build-base:latest \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy \
  -t soms:"$VER" -t soms:latest .

echo "done: soms:$VER, soms:latest (app + caddy, port 7667)"
