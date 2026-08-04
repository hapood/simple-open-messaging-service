#!/bin/sh
# Build soms-base:latest — node + the xcaddy-compiled Caddy (76 DNS providers). This is the RARELY-
# rebuilt base layer; the app image (build-image.sh) builds FROM it. Rebuild only when Caddy, a DNS
# provider, or the node base bumps. build-image.sh auto-calls this if soms-base is missing; run it
# manually to force a base refresh.
#   ./scripts/build-base.sh
#
# Network: Dockerfile.base uses the OFFICIAL Go registry (no CN mirror). To build from behind a
# restricted network, export the proxy vars (forwarded verbatim) — or rely on the Docker client proxy
# (~/.docker/config.json "proxies", auto-injected into build containers). The base-image pull (Docker
# Hub) needs the daemon mirror (/etc/docker/daemon.json "registry-mirrors") or an override:
#   NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim ./scripts/build-base.sh
# xcaddy fetches Go modules via GOPROXY (default proxy.golang.org); override for CN:
#   GOPROXY=https://goproxy.cn,direct ./scripts/build-base.sh
#
# --pull is on by default (base-image security updates). Set PULL=0 for an air-gapped rebuild against
# already-pulled bases. --network=host lets a build container reach a system proxy bound to the host
# loopback; the proxy address itself comes only from the invoking environment or Docker client config.
set -e
export DOCKER_BUILDKIT=1

NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"
GOPROXY="${GOPROXY:-https://proxy.golang.org,direct}"
# `if` form (not `[ ] && cmd`) so PULL=0 doesn't trip set -e on the failing test.
PULL_FLAG=""
if [ "${PULL:-1}" = "1" ]; then
  PULL_FLAG="--pull"
fi

echo "building soms-base:latest (base: $NODE_IMAGE, goproxy: $GOPROXY, pull: ${PULL:-1}) — node + caddy (xcaddy)…"
# shellcheck disable=SC2086 # PULL_FLAG is intentionally unquoted: "" when PULL=0, "--pull" otherwise.
docker build $PULL_FLAG --network=host -f Dockerfile.base -t soms-base:latest \
  --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg GOPROXY="$GOPROXY" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy .

echo "done: soms-base:latest (node + caddy + 76 DNS providers)"
