#!/bin/sh
# Build the SOMS image tagged with the version from package.json (+ latest).
# Release flow: npm version patch && git push --tags && ./scripts/build-image.sh
#
# Network: the Dockerfile uses the OFFICIAL npm/apt registries (no CN mirrors). To build from behind
# a restricted network, export the standard proxy vars in your shell — they are forwarded to the
# build verbatim (bare --build-arg pulls each from the local env; unset = direct):
#   export HTTPS_PROXY=http://192.168.88.8:8080   # your LAN/VPN proxy
#   ./scripts/build-image.sh
# The base-image pull (Docker Hub) additionally needs the Docker DAEMON configured with the proxy
# (~/.docker/config.json "proxies" or systemd). If that's not possible, override NODE_IMAGE:
#   NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim ./scripts/build-image.sh
set -e

VER=$(node -p "require('./package.json').version")
NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"
echo "building soms:$VER (base: $NODE_IMAGE, also tagged latest)..."
docker build \
  --build-arg APP_VERSION="$VER" \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy \
  -t soms:"$VER" -t soms:latest .
echo "done: soms:$VER, soms:latest"
