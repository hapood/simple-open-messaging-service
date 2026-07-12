#!/bin/sh
# Build BOTH SOMS image variants from one Dockerfile:
#   soms:$VER  / soms:latest      full  — app + Caddy bundled, publishes 7667 (the default/simple path).
#   soms:$VER-slim / soms:slim    slim  — app only, exposes 3000 (operator brings own reverse proxy).
# The slim build targets the `runtime` stage (skips the xcaddy caddy-build stage entirely); the full
# build is the default last stage. Both share the expensive web/admin/server build layers.
#
# Release flow: npm version patch && git push --tags && ./scripts/build-image.sh
#
# Network: the Dockerfile uses the OFFICIAL npm/apt registries (no CN mirrors). To build from behind
# a restricted network, export the standard proxy vars in your shell — they are forwarded to the build
# verbatim (bare --build-arg pulls each from the local env; unset = direct):
#   export HTTPS_PROXY=http://192.168.88.8:8080   # your LAN/VPN proxy
#   ./scripts/build-image.sh
# The base-image pull (Docker Hub) additionally needs the Docker DAEMON configured with the proxy
# (~/.docker/config.json "proxies" or systemd). If that's not possible, override NODE_IMAGE:
#   NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim ./scripts/build-image.sh
# The caddy-build stage fetches Go modules via GOPROXY (default proxy.golang.org); override for CN:
#   GOPROXY=https://goproxy.cn,direct ./scripts/build-image.sh
#
# --pull is on by default so release builds pick up base-image security updates. Set PULL=0 for an
# air-gapped rebuild against an already-pulled base (skips the registry round-trip).
#
# BuildKit is required: the Dockerfile uses RUN --mount=type=cache to persist the npm cache across
# builds. BuildKit is the default builder on Docker 23+; DOCKER_BUILDKIT=1 is set defensively for
# older daemons.
set -e
export DOCKER_BUILDKIT=1

VER=$(node -p "require('./package.json').version")
NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"
GOPROXY="${GOPROXY:-https://proxy.golang.org,direct}"
# `if` form (not `[ ] && cmd`) so PULL=0 doesn't trip set -e on the failing test.
PULL_FLAG=""
if [ "${PULL:-1}" = "1" ]; then
  PULL_FLAG="--pull"
fi

echo "building soms:$VER-slim (base: $NODE_IMAGE, pull: ${PULL:-1}) — app only, --target runtime..."
# shellcheck disable=SC2086 # PULL_FLAG is intentionally unquoted: "" when PULL=0, "--pull" otherwise.
docker build $PULL_FLAG --target runtime \
  --build-arg APP_VERSION="$VER" \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy \
  -t soms:"$VER"-slim -t soms:slim .

echo "building soms:$VER (base: $NODE_IMAGE, goproxy: $GOPROXY, pull: ${PULL:-1}, also tagged latest) — full: app + caddy..."
# shellcheck disable=SC2086
docker build $PULL_FLAG \
  --build-arg APP_VERSION="$VER" \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg GOPROXY="$GOPROXY" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy \
  -t soms:"$VER" -t soms:latest .

echo "done:"
echo "  slim: soms:$VER-slim, soms:slim       (app only, port 3000)"
echo "  full: soms:$VER, soms:latest          (app + caddy, port 7667)"
