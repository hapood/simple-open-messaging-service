#!/bin/sh
# Build soms-base:latest — node + the xcaddy-compiled Caddy (76 DNS providers). This is the RARELY-
# rebuilt base layer; the app image (build-image.sh) builds FROM it. Rebuild only when Caddy, a DNS
# provider, or the node base bumps. build-image.sh auto-calls this if soms-base is missing; run it
# manually to force a base refresh.
#   ./scripts/build-base.sh
#
# Network: Dockerfile.base uses the OFFICIAL Go registry (no CN mirror). Proxy variables are
# forwarded VERBATIM (see scripts/build-common.sh) — use an address build containers can reach,
# or BUILD_NETWORK=host for a loopback proxy.
# The base-image pull (Docker Hub) needs the daemon mirror (/etc/docker/daemon.json
# "registry-mirrors") or an image override pointing at any reachable registry mirror:
#   NODE_IMAGE=<registry-mirror>/library/node:24-bookworm-slim ./scripts/build-base.sh
#   CADDY_BUILDER_IMAGE=<registry-mirror>/library/caddy:2.11-builder ./scripts/build-base.sh
# xcaddy fetches Go modules via GOPROXY (default proxy.golang.org); override for CN:
#   GOPROXY=https://goproxy.cn,direct ./scripts/build-base.sh
#
# --pull is on by default (base-image security updates). Set PULL=0 for an air-gapped rebuild
# against already-pulled bases.
set -e
export DOCKER_BUILDKIT=1
# This script takes no arguments; configuration is via environment variables (header above).
# Fail fast instead of silently ignoring unexpected arguments.
if [ "$#" -gt 0 ]; then
  echo "unexpected argument(s): $* — configure via environment variables, or invoke docker build directly for raw flags." >&2
  exit 2
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR/.."
. "$SCRIPT_DIR/build-common.sh"

NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"
CADDY_BUILDER_IMAGE="${CADDY_BUILDER_IMAGE:-caddy:2.11-builder}"
GOPROXY="${GOPROXY:-https://proxy.golang.org,direct}"
BUILD_NETWORK="${BUILD_NETWORK:-default}"
# `if` form (not `[ ] && cmd`) so PULL=0 doesn't trip set -e on the failing test.
PULL_FLAG=""
if [ "${PULL:-1}" = "1" ]; then
  PULL_FLAG="--pull"
fi

echo "building soms-base:latest (base: $NODE_IMAGE, caddy builder: $CADDY_BUILDER_IMAGE, goproxy: $GOPROXY, pull: ${PULL:-1}) — node + caddy (xcaddy)…"
# shellcheck disable=SC2086 # PULL_FLAG is intentionally unquoted: "" when PULL=0, "--pull" otherwise.
run_docker build $PULL_FLAG --network="$BUILD_NETWORK" -f Dockerfile.base -t soms-base:latest \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg CADDY_BUILDER_IMAGE="$CADDY_BUILDER_IMAGE" \
  --build-arg GOPROXY="$GOPROXY" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy .

echo "done: soms-base:latest (node + caddy + 76 DNS providers)"
