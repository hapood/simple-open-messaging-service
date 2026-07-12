#!/bin/sh
# Build SOMS in two layers:
#   1. soms-base:latest  — node + the xcaddy-compiled Caddy (76 DNS providers). Rebuilt only when Caddy,
#      a provider, or the node base bumps; otherwise BuildKit cache makes it a near-instant no-op.
#      (Dockerfile.base)
#   2. soms:latest        — the app image, FROM soms-base. Fast: never re-runs xcaddy. (Dockerfile)
#
# Release flow: npm version patch && git push --tags && ./scripts/build-image.sh
#
# Network: the Dockerfiles use the OFFICIAL npm/apt/Go registries (no CN mirrors). To build from behind
# a restricted network, export the standard proxy vars in your shell — they are forwarded verbatim
# (bare --build-arg pulls each from the local env; unset = direct):
#   export HTTPS_PROXY=http://192.168.88.8:8080   # your LAN/VPN proxy
#   ./scripts/build-image.sh
# The base-image pull (Docker Hub) additionally needs the Docker DAEMON configured with the proxy
# (~/.docker/config.json "proxies" or systemd). If that's not possible, override NODE_IMAGE:
#   NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim ./scripts/build-image.sh
# The base layer's xcaddy fetches Go modules via GOPROXY (default proxy.golang.org); override for CN:
#   GOPROXY=https://goproxy.cn,direct ./scripts/build-image.sh
#
# --pull is on by default so release builds pick up base-image security updates. Set PULL=0 for an
# air-gapped rebuild against already-pulled bases (skips the registry round-trip).
#
# BuildKit is required: the Dockerfiles use RUN --mount=type=cache. Default builder on Docker 23+;
# DOCKER_BUILDKIT=1 is set defensively for older daemons.
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

echo "building soms-base:latest (base: $NODE_IMAGE, goproxy: $GOPROXY, pull: ${PULL:-1}) — node + caddy (xcaddy)…"
# shellcheck disable=SC2086 # PULL_FLAG is intentionally unquoted: "" when PULL=0, "--pull" otherwise.
docker build $PULL_FLAG -f Dockerfile.base -t soms-base:latest \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg GOPROXY="$GOPROXY" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy .

echo "building soms:$VER (base: $NODE_IMAGE, FROM soms-base:latest, pull: ${PULL:-1}, also tagged latest) — app…"
# shellcheck disable=SC2086
docker build $PULL_FLAG \
  --build-arg APP_VERSION="$VER" \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg SOMS_BASE=soms-base:latest \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy \
  -t soms:"$VER" -t soms:latest .

echo "done:"
echo "  soms-base:latest            (node + caddy + 76 DNS providers — rebuild only when these bump)"
echo "  soms:$VER, soms:latest      (app + caddy, port 7667)"
