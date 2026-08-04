#!/usr/bin/env bash
# Smoke tests for the environment-driven Caddyfile renderer.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INIT="$HERE/init.sh"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

render() {
  rm -rf "$SANDBOX/run"
  mkdir -p "$SANDBOX/run"
  env -i PATH="$PATH" \
    SOMS_DOMAIN=test.local \
    SOMS_WEB_DOMAIN=web.test.local \
    SOMS_TLS_MODE="${1:-single-port}" \
    SOMS_ADMIN_ACCESS="${2:-public}" \
    PGPASSWORD='pw with @:/?# characters' \
    ADMIN_BOOTSTRAP_PASSWORD='admin password with spaces' \
    DATABASE_POOL_MAX=10 \
    CLOUDFLARE_API_TOKEN=cf-token \
    SOMS_RUN_DIR="$SANDBOX/run" \
    "$INIT" >/dev/null
}

contains() {
  grep -Fq "$1" "$SANDBOX/run/Caddyfile" || {
    echo "missing from Caddyfile: $1" >&2
    exit 1
  }
}

render single-port
contains 'https://test.local:7667, https://*.test.local:7667 {'
# web.test.local is already covered by *.test.local and must not create a duplicate site block.
test "$(grep -Fc 'https://web.test.local:7667' "$SANDBOX/run/Caddyfile")" = 0
contains 'dns cloudflare cf-token'
contains 'handle /api*'
contains 'handle /.well-known/*'
contains 'root * /app/public/web'
contains 'redir /admin /admin/ 308'
test "$(stat -c %a "$SANDBOX/run/Caddyfile")" = 600

render standard
contains 'https://test.local, https://*.test.local {'
contains 'https://test.local:7667, https://*.test.local:7667 {'

render disabled lan
contains 'http://test.local:7667, http://*.test.local:7667 {'
contains '@not_lan not remote_ip'
contains 'handle /admin {'
contains 'respond @not_lan 403'
contains 'redir * /admin/ 308'

if env -i PATH="$PATH" SOMS_TLS_MODE=disabled PGPASSWORD=pw \
  ADMIN_BOOTSTRAP_PASSWORD=admin DATABASE_POOL_MAX=10 SOMS_RUN_DIR="$SANDBOX/run" \
  "$INIT" >/dev/null 2>&1; then
  echo 'renderer accepted a missing SOMS_DOMAIN' >&2
  exit 1
fi

echo 'Caddyfile renderer tests passed'
