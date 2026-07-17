#!/bin/sh
# Build soms:latest — the app image (FROM soms-base). If soms-base:latest is missing locally, this
# auto-calls ./scripts/build-base.sh to build it first. To REFRESH the base (Caddy / DNS provider /
# node bumped), run ./scripts/build-base.sh yourself.
#   ./scripts/build-image.sh
#
# Network: the compile stages (web/admin/server) use OFFICIAL npm/apt via the Docker client proxy
# (~/.docker/config.json "proxies", auto-injected into build containers). --network=host reaches the
# host's clash (127.0.0.1:7890) — build containers have their own loopback, so they must share the
# host net. NODE_IMAGE overrides the compile-stage base if Docker Hub is unreachable.
set -e
export DOCKER_BUILDKIT=1

VER=$(node -p "require('./package.json').version")
NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"

# Auto-build the base if it's missing (first build, or after `docker rmi soms-base`). build-base.sh
# inherits this script's env (NODE_IMAGE, PULL, proxy vars), so overrides pass through.
if ! docker image inspect soms-base:latest >/dev/null 2>&1; then
  echo "soms-base:latest not found locally — building it first (./scripts/build-base.sh)…"
  "$(dirname "$0")"/build-base.sh
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
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy \
  -t soms:"$VER" -t soms:latest .

echo "done: soms:$VER, soms:latest (app + caddy, port 7667)"
