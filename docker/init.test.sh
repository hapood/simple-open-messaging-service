#!/usr/bin/env bash
# Tests for docker/init.sh — the deployment-config generator (DATABASE_URL, Caddyfile, pg-password,
# app.env). Runs init.sh in a temp sandbox with `chown` stubbed (so it works non-root) and asserts on
# the generated files. Catches regressions in the {KEY} transcription, DATABASE_URL construction,
# pass-through, the SOMS_TLS_MODE edge modes (custom/standard/disabled), and the required-field
# fail-fast paths.
#   Run:  bash docker/init.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INIT="$HERE/init.sh"
PASS=0; FAIL=0

# Stub chown (no-op) so the test runs as non-root without touching real paths.
STUBBIN="$(mktemp -d)"; trap 'rm -rf "$STUBBIN"' EXIT
printf '#!/bin/sh\n:\n' > "$STUBBIN/chown"; chmod +x "$STUBBIN/chown"

SANDBOX=""
# run_init <conf> — runs init.sh in a fresh sandbox; does NOT abort on failure (asserts catch it).
run_init() {
  SANDBOX="$(mktemp -d)"; mkdir -p "$SANDBOX/run"
  printf '%s\n' "$1" > "$SANDBOX/soms.conf"
  SOMS_CONFIG="$SANDBOX/soms.conf" SOMS_RUN_DIR="$SANDBOX/run" APPDATA_DIR="$SANDBOX/appdata" PGDATA_DIR="$SANDBOX/pgdata" \
    PATH="$STUBBIN:$PATH" bash "$INIT" >"$SANDBOX/out" 2>"$SANDBOX/err" || echo "  (init exited $?)"
}
assert_contains() { # <file> <needle>
  if grep -qF "$2" "$1" 2>/dev/null; then echo "  ok: $2"; PASS=$((PASS+1));
  else echo "  FAIL: expected [$2] in $1"; echo "$(sed 's/^/      | /' "$1" 2>/dev/null)"; FAIL=$((FAIL+1)); fi
}
assert_not_contains() { # <file> <needle>
  if grep -qF "$2" "$1" 2>/dev/null; then echo "  FAIL: [$2] should NOT be in $1"; FAIL=$((FAIL+1));
  else echo "  ok: [$2] absent"; PASS=$((PASS+1)); fi
}
expect_fail() { # <conf> <needle-in-stderr>
  local sb; sb="$(mktemp -d)"; mkdir -p "$sb/run"; printf '%s\n' "$1" > "$sb/soms.conf"
  if SOMS_CONFIG="$sb/soms.conf" SOMS_RUN_DIR="$sb/run" APPDATA_DIR="$sb/appdata" PGDATA_DIR="$sb/pgdata" \
     PATH="$STUBBIN:$PATH" bash "$INIT" >"$sb/out" 2>"$sb/err"; then
    echo "  FAIL: expected init to FAIL, but it succeeded"; FAIL=$((FAIL+1)); rm -rf "$sb"; return
  fi
  if grep -qF "$2" "$sb/err"; then echo "  ok (failed as expected): $2"; PASS=$((PASS+1));
  else echo "  FAIL: expected stderr [$2], got: $(cat "$sb/err")"; FAIL=$((FAIL+1)); fi
  rm -rf "$sb"
}

# Common required fields (every test must satisfy these); append mode + test-specific vars per case.
REQ=$'SOMS_DOMAIN=test.local\nPOSTGRES_PASSWORD=pw\nADMIN_BOOTSTRAP_PASSWORD=ap\nDATABASE_POOL_MAX=10'

echo "== custom mode: Cloudflare default directive =="
run_init "$REQ"$'\nSOMS_TLS_MODE=custom\nCLOUDFLARE_API_TOKEN=cf-tok'
assert_contains "$SANDBOX/run/pg-password" "pw"
assert_contains "$SANDBOX/run/app.env" "DATABASE_URL=postgresql://timescale:pw@postgres:5432/soms?schema=public"
assert_contains "$SANDBOX/run/app.env" "SOMS_DOMAIN=test.local"
assert_contains "$SANDBOX/run/Caddyfile" "https://test.local:7667, https://*.test.local:7667"
assert_contains "$SANDBOX/run/Caddyfile" "auto_https disable_redirects"
assert_contains "$SANDBOX/run/Caddyfile" "dns cloudflare cf-tok"
assert_contains "$SANDBOX/run/Caddyfile" "handle /api*"
assert_contains "$SANDBOX/run/Caddyfile" "handle /uploads*"
assert_contains "$SANDBOX/run/Caddyfile" "handle /admin*"
assert_contains "$SANDBOX/run/Caddyfile" "root * /app/public/web"
assert_not_contains "$SANDBOX/run/app.env" "CLOUDFLARE_API_TOKEN"
# SOMS_ADMIN_ACCESS unset → public default → no admin LAN-guard in the Caddyfile.
assert_not_contains "$SANDBOX/run/Caddyfile" "@not_lan"

echo "== standard mode: 443 + auto 80→443 redirect + 7667 federation (snippet) =="
run_init "$REQ"$'\nSOMS_TLS_MODE=standard\nCLOUDFLARE_API_TOKEN=cf-tok'
assert_not_contains "$SANDBOX/run/Caddyfile" "auto_https disable_redirects"
assert_contains "$SANDBOX/run/Caddyfile" "(soms_site) {"
assert_contains "$SANDBOX/run/Caddyfile" "https://test.local, https://*.test.local {"
assert_contains "$SANDBOX/run/Caddyfile" "https://test.local:7667, https://*.test.local:7667 {"
assert_contains "$SANDBOX/run/Caddyfile" "import soms_site"
assert_contains "$SANDBOX/run/Caddyfile" "dns cloudflare cf-tok"

echo "== disabled mode: plain HTTP, no cert =="
run_init "$REQ"$'\nSOMS_TLS_MODE=disabled'
assert_contains "$SANDBOX/run/Caddyfile" "http://test.local:7667, http://*.test.local:7667"
assert_not_contains "$SANDBOX/run/Caddyfile" "tls {"
assert_contains "$SANDBOX/run/Caddyfile" "auto_https disable_redirects"

echo "== SOMS_ADMIN_ACCESS=lan: admin page + API gated to private IPs =="
run_init "$REQ"$'\nSOMS_TLS_MODE=custom\nCLOUDFLARE_API_TOKEN=cf-tok\nSOMS_ADMIN_ACCESS=lan'
assert_contains "$SANDBOX/run/Caddyfile" "@not_lan not remote_ip"
assert_contains "$SANDBOX/run/Caddyfile" "192.168.0.0/16"
assert_contains "$SANDBOX/run/Caddyfile" "handle /api/v1/admin* {"
assert_contains "$SANDBOX/run/Caddyfile" "respond @not_lan 403"
# The guard must precede the generic /api* handle (first-match-wins), and the knob must stay Caddy-only.
assert_not_contains "$SANDBOX/run/app.env" "SOMS_ADMIN_ACCESS"

echo "== SOMS_ALLOW_IP_ACCESS=true: domain site (DNS-01) + self-signed IP catch-all =="
run_init "$REQ"$'\nSOMS_TLS_MODE=custom\nCLOUDFLARE_API_TOKEN=cf-tok\nSOMS_ALLOW_IP_ACCESS=true'
assert_contains "$SANDBOX/run/Caddyfile" "(soms_handlers) {"
assert_contains "$SANDBOX/run/Caddyfile" "https://test.local:7667, https://*.test.local:7667 {"
assert_contains "$SANDBOX/run/Caddyfile" "dns cloudflare cf-tok"
assert_contains "$SANDBOX/run/Caddyfile" "import soms_handlers"
assert_contains "$SANDBOX/run/Caddyfile" "https://:7667 {"
assert_contains "$SANDBOX/run/Caddyfile" "tls $SANDBOX/appdata/selfsigned.crt $SANDBOX/appdata/selfsigned.key"
assert_not_contains "$SANDBOX/run/app.env" "SOMS_ALLOW_IP_ACCESS"
# The self-signed cert is generated once and persisted in APPDATA_DIR.
if [ -s "$SANDBOX/appdata/selfsigned.crt" ] && [ -s "$SANDBOX/appdata/selfsigned.key" ]; then
  echo "  ok: selfsigned.crt + .key generated"; PASS=$((PASS+1))
else echo "  FAIL: selfsigned cert files missing in $SANDBOX/appdata"; FAIL=$((FAIL+1)); fi

echo "== AliDNS block directive (inline creds do NOT leak to node) =="
run_init "$REQ"$'\nSOMS_TLS_MODE=custom\nALIYUN_ACCESS_KEY_ID=ak-1\nALIYUN_ACCESS_KEY_SECRET=sk-2\nCADDY_DNS_DIRECTIVE="dns alidns {\n  access_key_id {ALIYUN_ACCESS_KEY_ID}\n  access_key_secret {ALIYUN_ACCESS_KEY_SECRET}\n}"'
assert_contains "$SANDBOX/run/Caddyfile" "access_key_id ak-1"
assert_contains "$SANDBOX/run/Caddyfile" "access_key_secret sk-2"
assert_not_contains "$SANDBOX/run/app.env" "ALIYUN_ACCESS_KEY_ID"
assert_not_contains "$SANDBOX/run/app.env" "ALIYUN_ACCESS_KEY_SECRET"

echo "== Route 53 env-style directive (creds DO pass through) =="
run_init "$REQ"$'\nSOMS_TLS_MODE=custom\nCADDY_DNS_DIRECTIVE="dns route53"\nAWS_ACCESS_KEY_ID=aws-ak\nAWS_SECRET_ACCESS_KEY=aws-sk\nAWS_REGION=us-east-1'
assert_contains "$SANDBOX/run/Caddyfile" "dns route53"
assert_contains "$SANDBOX/run/app.env" "AWS_ACCESS_KEY_ID=aws-ak"
assert_contains "$SANDBOX/run/app.env" "AWS_REGION=us-east-1"
assert_not_contains "$SANDBOX/run/Caddyfile" "aws-ak"

echo "== POSTGRES_PASSWORD flows into both pg-password and DATABASE_URL =="
run_init "$REQ"$'\nSOMS_TLS_MODE=disabled\nPOSTGRES_PASSWORD=s3cr3t!'
assert_contains "$SANDBOX/run/pg-password" "s3cr3t!"
assert_contains "$SANDBOX/run/app.env" "timescale:s3cr3t!@postgres"

echo "== pass-through of an advanced var (excludes caddy-only keys) =="
run_init "$REQ"$'\nSOMS_TLS_MODE=custom\nCLOUDFLARE_API_TOKEN=t\nSOMS_QUOTA_DAILY_MSG_LIMIT=9000'
assert_contains "$SANDBOX/run/app.env" "SOMS_QUOTA_DAILY_MSG_LIMIT=9000"
assert_not_contains "$SANDBOX/run/app.env" "CLOUDFLARE_API_TOKEN"

echo "== missing SOMS_DOMAIN fails fast =="
expect_fail $'POSTGRES_PASSWORD=x\nADMIN_BOOTSTRAP_PASSWORD=y\nDATABASE_POOL_MAX=10\nSOMS_TLS_MODE=custom' "SOMS_DOMAIN is required"

echo "== invalid SOMS_TLS_MODE fails fast =="
expect_fail "$REQ"$'\nSOMS_TLS_MODE=bogus' "SOMS_TLS_MODE must be one of: custom | standard | disabled"

echo "== missing ADMIN_BOOTSTRAP_PASSWORD fails fast =="
expect_fail $'SOMS_DOMAIN=test.local\nPOSTGRES_PASSWORD=pw\nDATABASE_POOL_MAX=10\nSOMS_TLS_MODE=disabled' "ADMIN_BOOTSTRAP_PASSWORD is required"

echo "== missing DATABASE_POOL_MAX fails fast =="
expect_fail $'SOMS_DOMAIN=test.local\nPOSTGRES_PASSWORD=pw\nADMIN_BOOTSTRAP_PASSWORD=ap\nSOMS_TLS_MODE=disabled' "DATABASE_POOL_MAX is required"

echo "== missing {KEY} ref fails fast =="
expect_fail "$REQ"$'\nSOMS_TLS_MODE=custom\nCADDY_DNS_DIRECTIVE="dns cloudflare {CLOUDFLARE_API_TOKEN}"' \
  "references {CLOUDFLARE_API_TOKEN} but it is not set"

echo "== invalid SOMS_ADMIN_ACCESS fails fast =="
expect_fail "$REQ"$'\nSOMS_TLS_MODE=custom\nSOMS_ADMIN_ACCESS=bogus' "SOMS_ADMIN_ACCESS must be one of: public | lan"

echo "== SOMS_ALLOW_IP_ACCESS=true + disabled fails fast =="
expect_fail "$REQ"$'\nSOMS_TLS_MODE=disabled\nSOMS_ALLOW_IP_ACCESS=true' "SOMS_ALLOW_IP_ACCESS=true requires SOMS_TLS_MODE=custom"

echo "== invalid SOMS_ALLOW_IP_ACCESS fails fast =="
expect_fail "$REQ"$'\nSOMS_TLS_MODE=custom\nSOMS_ALLOW_IP_ACCESS=maybe' "SOMS_ALLOW_IP_ACCESS must be one of: true | false"

echo
echo "RESULT: pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
