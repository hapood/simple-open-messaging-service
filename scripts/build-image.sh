#!/bin/sh
# Build soms:latest through the repository's unified BuildKit graph. runtime-base and build-base are
# target contexts: BuildKit rebuilds them only when their inputs change and never pulls their local
# names from a registry. The dedicated base scripts remain available for local inspection/debugging.
#   ./scripts/build-image.sh
#
# Network: proxy variables are forwarded verbatim from the invoking environment. Host networking also
# permits a build container to reach a system proxy bound to the host loopback; no proxy address or
# port is defined here. NODE_IMAGE overrides the compile-stage base if Docker Hub is unreachable.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR/.."

# Distrobox installations may expose Docker only on the host. host-spawn does not inherit the
# caller's environment by default, so forward only the build settings and standard proxy variables.
run_docker() {
  if command -v docker >/dev/null 2>&1; then
    docker "$@"
  elif command -v host-spawn >/dev/null 2>&1; then
    host-spawn -no-pty -cwd "$PWD" \
      -env APP_VERSION,NODE_IMAGE,BUILD_NETWORK,GOPROXY,GOSUMDB,BUILDKIT_PROGRESS,HTTP_PROXY,HTTPS_PROXY,NO_PROXY,http_proxy,https_proxy,no_proxy \
      docker "$@"
  else
    echo 'Docker CLI is required (locally or through host-spawn).' >&2
    return 1
  fi
}
VER=$(node -p "require('./package.json').version")
NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"

echo "building soms:$VER (unified runtime-base + build-base + app graph)…"
# Host networking preserves support for proxies bound to the developer machine's loopback. CI uses
# Bake's default isolated network because it invokes the Bake target directly.
APP_VERSION="$VER" NODE_IMAGE="$NODE_IMAGE" BUILD_NETWORK=host run_docker buildx bake app \
  --allow=network.host \
  --set app.output=type=docker

echo "done: soms:$VER, soms:latest (app + caddy, port 7667)"
