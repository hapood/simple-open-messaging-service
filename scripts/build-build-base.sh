#!/bin/sh
# Build the reusable server compilation image (Node + python3/make/g++). This image is used only by
# Dockerfile's server-build stage; none of its toolchain is copied into soms:latest. Proxy variables
# are forwarded from the invoking environment; this script does not define a proxy address or port.
set -e
export DOCKER_BUILDKIT=1

NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"
PULL_FLAG=""
if [ "${PULL:-1}" = "1" ]; then
  PULL_FLAG="--pull"
fi

echo "building soms-build-base:latest (base: $NODE_IMAGE, pull: ${PULL:-1}) — node + native build toolchain…"
# shellcheck disable=SC2086 # Empty when PULL=0, otherwise expands to the single --pull option.
docker build $PULL_FLAG --network=host -f Dockerfile.build-base -t soms-build-base:latest \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy .

echo "done: soms-build-base:latest (server compilation only)"
