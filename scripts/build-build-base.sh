#!/bin/sh
# Build the reusable server compilation image (Node + python3/make/g++). This image is used only by
# Dockerfile's server-build stage; none of its toolchain is copied into soms:latest. Proxy variables
# are forwarded VERBATIM (see scripts/build-common.sh) — use an address build containers can reach,
# or BUILD_NETWORK=host for a loopback proxy.
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
BUILD_NETWORK="${BUILD_NETWORK:-default}"
PULL_FLAG=""
if [ "${PULL:-1}" = "1" ]; then
  PULL_FLAG="--pull"
fi

echo "building soms-build-base:latest (base: $NODE_IMAGE, pull: ${PULL:-1}) — node + native build toolchain…"
# shellcheck disable=SC2086 # Empty when PULL=0, otherwise expands to the single --pull option.
run_docker build $PULL_FLAG --network="$BUILD_NETWORK" -f Dockerfile.build-base -t soms-build-base:latest \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy .

echo "done: soms-build-base:latest (server compilation only)"
