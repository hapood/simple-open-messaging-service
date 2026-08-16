#!/bin/sh
# Build soms:latest through the repository's unified BuildKit graph. runtime-base and build-base are
# target contexts: BuildKit rebuilds them only when their inputs change and never pulls their local
# names from a registry. The dedicated base scripts remain available for local inspection/debugging.
#   ./scripts/build-image.sh
#
# Network: proxy variables are forwarded verbatim from the invoking environment. --network=host also
# permits a build container to reach a system proxy bound to the host loopback; no proxy address or
# port is defined here. NODE_IMAGE overrides the compile-stage base if Docker Hub is unreachable.
set -e
VER=$(node -p "require('./package.json').version")
NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"

echo "building soms:$VER (unified runtime-base + build-base + app graph)…"
# Host networking preserves support for proxies bound to the developer machine's loopback. CI uses
# Bake's default isolated network because it invokes the Bake target directly.
APP_VERSION="$VER" NODE_IMAGE="$NODE_IMAGE" docker buildx bake app \
  --set app.output=type=docker \
  --set '*.network=host'

echo "done: soms:$VER, soms:latest (app + caddy, port 7667)"
