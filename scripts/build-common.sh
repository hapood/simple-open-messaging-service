# Shared build helpers, sourced (never executed) by scripts/build-image.sh, scripts/build-base.sh,
# and scripts/build-build-base.sh.
# shellcheck shell=sh

# Distrobox installations may expose Docker only on the host. host-spawn does not inherit the
# caller's environment by default, so forward only the build settings and standard proxy variables
# the calling scripts (or a wrapping script) set. Proxy values are forwarded VERBATIM — no address
# rewriting happens anywhere.
run_docker() {
  if command -v docker >/dev/null 2>&1; then
    docker "$@"
  elif command -v host-spawn >/dev/null 2>&1; then
    host-spawn -no-pty -cwd "$PWD" \
      -env APP_VERSION,NODE_IMAGE,CADDY_BUILDER_IMAGE,BUILD_NETWORK,GOPROXY,GOSUMDB,BUILDKIT_PROGRESS,HTTP_PROXY,HTTPS_PROXY,NO_PROXY,http_proxy,https_proxy,no_proxy \
      docker "$@"
  else
    echo 'Docker CLI is required (locally or through host-spawn).' >&2
    return 1
  fi
}
