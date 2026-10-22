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
    CADDY_DNS_DIRECTIVE='dns cloudflare {env.CLOUDFLARE_API_TOKEN}' \
    SOMS_RUN_DIR="$SANDBOX/run" \
    "${@:3}" \
    "$INIT" >/dev/null
  # Every site and mode must route federation POSTs before the SPA fallback.
  node - "$SANDBOX/run/Caddyfile" <<'JS'
const assert = require('node:assert/strict');
const text = require('node:fs').readFileSync(process.argv[2], 'utf8');
const blocks = text.split('\thandle /.well-known/* {').slice(1);
assert.ok(blocks.length, 'no backend handlers generated');
for (const block of blocks) {
  const rule = '\thandle /s2s/* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}';
  assert.ok(block.includes(rule), 'missing path-preserving federation proxy');
  assert.ok(block.indexOf(rule) < block.indexOf('\thandle {'), 'federation proxy follows SPA');
}
JS
  if [ -n "${CADDY_BIN:-}" ]; then
    "$CADDY_BIN" adapt --config "$SANDBOX/run/Caddyfile" --adapter caddyfile >/dev/null
  fi
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
contains 'dns cloudflare {env.CLOUDFLARE_API_TOKEN}'
! grep -Fq 'cf-token' "$SANDBOX/run/Caddyfile"
contains 'handle /api*'
contains 'handle /.well-known/*'
contains 'root * /app/public/web'
contains 'redir /admin /admin/ 308'
contains 'header Cache-Control "no-cache"'
contains 'handle /push/*.js {'
contains 'header @web_immutable Cache-Control "public, max-age=31536000, immutable"'
contains 'header @admin_immutable Cache-Control "public, max-age=31536000, immutable"'
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

render single-port public CLOUDFLARE_API_TOKEN=$'sensitive-marker space "quote" \\ backslash & {$OTHER}\nnewline'
contains 'dns cloudflare {env.CLOUDFLARE_API_TOKEN}'
! grep -Fq 'sensitive-marker' "$SANDBOX/run/Caddyfile"

render single-port public \
  CADDY_DNS_DIRECTIVE=$'dns alidns {\n access_key_id {env.ALIYUN_ACCESS_KEY_ID}\n access_key_secret {env.ALIYUN_ACCESS_KEY_SECRET}\n}' \
  ALIYUN_ACCESS_KEY_ID=example-id ALIYUN_ACCESS_KEY_SECRET=example-secret
contains 'access_key_secret {env.ALIYUN_ACCESS_KEY_SECRET}'
! grep -Fq 'example-secret' "$SANDBOX/run/Caddyfile"

render single-port public \
  CADDY_DNS_DIRECTIVE=$'dns tencentcloud {\n secret_id {env.TENCENTCLOUD_SECRET_ID}\n secret_key {env.TENCENTCLOUD_SECRET_KEY}\n}' \
  TENCENTCLOUD_SECRET_ID=example-id TENCENTCLOUD_SECRET_KEY=example-secret
contains 'secret_key {env.TENCENTCLOUD_SECRET_KEY}'

render single-port public CADDY_DNS_DIRECTIVE='dns route53'
contains 'dns route53'
render disabled public CLOUDFLARE_API_TOKEN= CADDY_DNS_DIRECTIVE=
! grep -Fq 'dns cloudflare' "$SANDBOX/run/Caddyfile"

expect_failure() {
  local expected="$1"
  shift
  # Invoke the renderer directly: testing a function in an if-condition disables its errexit.
  if env -i PATH="$PATH" SOMS_DOMAIN=test.local SOMS_TLS_MODE=single-port \
    CLOUDFLARE_API_TOKEN=cf-token SOMS_RUN_DIR="$SANDBOX/run" \
    CADDY_DNS_DIRECTIVE='dns cloudflare {env.CLOUDFLARE_API_TOKEN}' \
    "$@" "$INIT" >"$SANDBOX/failure.log" 2>&1; then
    echo 'renderer accepted invalid configuration' >&2
    exit 1
  fi
  grep -Fq "$expected" "$SANDBOX/failure.log"
}

expect_failure 'references {env.CLOUDFLARE_API_TOKEN} but it is not set' CLOUDFLARE_API_TOKEN=
expect_failure 'CADDY_DNS_DIRECTIVE is required when TLS is enabled' CADDY_DNS_DIRECTIVE=
expect_failure 'references {env.MISSING_TOKEN} but it is not set' \
  CADDY_DNS_DIRECTIVE='dns cloudflare {env.MISSING_TOKEN}'
expect_failure 'must use native {env.NAME} references' \
  CADDY_DNS_DIRECTIVE='dns cloudflare {CLOUDFLARE_API_TOKEN}'
expect_failure 'must use native {env.NAME} references' \
  CADDY_DNS_DIRECTIVE='dns cloudflare {$CLOUDFLARE_API_TOKEN}'
expect_failure 'SOMS_ADMIN_ACCESS must be one of: public | lan' SOMS_ADMIN_ACCESS=invalid
! grep -Fq 'unbound variable' "$SANDBOX/failure.log"

if env -i PATH="$PATH" SOMS_TLS_MODE=disabled PGPASSWORD=pw \
  ADMIN_BOOTSTRAP_PASSWORD=admin DATABASE_POOL_MAX=10 SOMS_RUN_DIR="$SANDBOX/run" \
  "$INIT" >/dev/null 2>&1; then
  echo 'renderer accepted a missing SOMS_DOMAIN' >&2
  exit 1
fi

for direct_tls_var in TLS_CERT TLS_KEY; do
  conflict_output="$SANDBOX/$direct_tls_var-conflict.log"
  if env -i PATH="$PATH" SOMS_DOMAIN=test.local SOMS_TLS_MODE=standard \
    CLOUDFLARE_API_TOKEN=cf-token PGPASSWORD=pw ADMIN_BOOTSTRAP_PASSWORD=admin \
    DATABASE_POOL_MAX=10 SOMS_RUN_DIR="$SANDBOX/run" \
    "$direct_tls_var=/etc/ssl/chat/test.pem" "$INIT" > /dev/null 2>"$conflict_output"; then
    echo "renderer accepted $direct_tls_var in the Caddy-managed full image" >&2
    exit 1
  fi
  grep -Fq 'conflicting TLS configuration: TLS_CERT/TLS_KEY cannot be used with Caddy automatic DNS-01 TLS (SOMS_TLS_MODE=standard); remove TLS_CERT and TLS_KEY' "$conflict_output" || {
    echo "renderer did not explain the $direct_tls_var/Caddy TLS conflict" >&2
    exit 1
  }
done

echo 'Caddyfile renderer tests passed'
