#!/bin/sh
# Build soms:latest through the repository's unified BuildKit graph. runtime-base and build-base are
# target contexts: BuildKit rebuilds them only when their inputs change and never pulls their local
# names from a registry. The dedicated base scripts remain available for local inspection/debugging.
#   ./scripts/build-image.sh
#
# Network: builds run on the isolated default bridge. Proxy variables are forwarded VERBATIM from
# the invoking environment — no address rewriting happens here, so a loopback proxy is only
# reachable under BUILD_NETWORK=host; an address the build containers can reach is required
# otherwise. NODE_IMAGE / CADDY_BUILDER_IMAGE override the base images if Docker Hub is unreachable.
# CI invokes the Bake target directly and uses its own isolated default network.
set -eu
# This script takes no arguments; configuration is via environment variables (header above).
# Fail fast instead of silently ignoring unexpected arguments.
if [ "$#" -gt 0 ]; then
  echo "unexpected argument(s): $* — configure via environment variables, or invoke docker buildx bake directly for raw flags." >&2
  exit 2
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR/.."
. "$SCRIPT_DIR/build-common.sh"

VER=$(node -p "require('./package.json').version")
NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"
CADDY_BUILDER_IMAGE="${CADDY_BUILDER_IMAGE:-caddy:2.11-builder}"
BUILD_NETWORK="${BUILD_NETWORK:-default}"

echo "building soms:$VER (unified runtime-base + build-base + app graph; network: $BUILD_NETWORK)…"
APP_VERSION="$VER" NODE_IMAGE="$NODE_IMAGE" CADDY_BUILDER_IMAGE="$CADDY_BUILDER_IMAGE" \
  BUILD_NETWORK="$BUILD_NETWORK" run_docker buildx bake app \
  --allow=network.host \
  --set app.output=type=docker

echo "done: soms:$VER, soms:latest (app + caddy, port 7667)"
