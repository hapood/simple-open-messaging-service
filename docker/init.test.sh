#!/usr/bin/env bash
# Tests for docker/init.sh — the deployment-config generator (DATABASE_URL, Caddyfile, pg-password,
# app.env). Runs init.sh in a temp sandbox with `chown` stubbed (so it works non-root) and asserts on the
# generated files. Catches regressions in the {KEY} transcription, DATABASE_URL construction, pass-through,
# and the required-field fail-fast paths.
#   Run:  bash docker/init.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INIT="$HERE/init.sh"
PASS=0; FAIL=0

# Stub chown (no-op) so the test runs as non-root without touching real paths.
STUBBIN="$(mktemp -d)"; trap 'rm -rf "$STUBBIN"' EXIT
printf '#!/usr/bin/env bash\n:\n' > "$STUBBIN/chown"; chmod +x "$STUBBIN/chown"

SANDBOX=""
# run_init <conf-heredoc> — runs init.sh in a fresh sandbox; does NOT abort on failure (asserts catch it).
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
expect_fail() { # <conf-heredoc> <needle-in-stderr>
  local sb; sb="$(mktemp -d)"; mkdir -p "$sb/run"; printf '%s\n' "$1" > "$sb/soms.conf"
  if SOMS_CONFIG="$sb/soms.conf" SOMS_RUN_DIR="$sb/run" APPDATA_DIR="$sb/appdata" PGDATA_DIR="$sb/pgdata" \
     PATH="$STUBBIN:$PATH" bash "$INIT" >"$sb/out" 2>"$sb/err"; then
    echo "  FAIL: expected init to FAIL, but it succeeded"; FAIL=$((FAIL+1)); rm -rf "$sb"; return
  fi
  if grep -qF "$2" "$sb/err"; then echo "  ok (failed as expected): $2"; PASS=$((PASS+1));
  else echo "  FAIL: expected stderr [$2], got: $(cat "$sb/err")"; FAIL=$((FAIL+1)); fi
  rm -rf "$sb"
}

echo "== Cloudflare (default directive) =="
run_init $'SOMS_DOMAIN=test.local\nCLOUDFLARE_API_TOKEN=cf-tok'
assert_contains "$SANDBOX/run/pg-password" "change-me"
assert_contains "$SANDBOX/run/app.env" "DATABASE_URL=postgresql://timescale:change-me@postgres:5432/soms?schema=public"
assert_contains "$SANDBOX/run/app.env" "SOMS_DOMAIN=test.local"
assert_contains "$SANDBOX/run/Caddyfile" "https://test.local:7667"
assert_contains "$SANDBOX/run/Caddyfile" "dns cloudflare cf-tok"
assert_contains "$SANDBOX/run/Caddyfile" "handle /api*"        # API → Fastify
assert_contains "$SANDBOX/run/Caddyfile" "handle /uploads*"    # auth-gated media → Fastify
assert_contains "$SANDBOX/run/Caddyfile" "handle /admin*"      # admin SPA → Caddy file_server
assert_contains "$SANDBOX/run/Caddyfile" "root * /app/public/web"   # web SPA → Caddy file_server
assert_not_contains "$SANDBOX/run/app.env" "CLOUDFLARE_API_TOKEN"   # caddy-only; must not leak to node env

echo "== AliDNS 2-var directive (quoted; {KEY} transcription) =="
run_init $'SOMS_DOMAIN=test.local\nCADDY_DNS_DIRECTIVE="dns alidns {ALICLOUD_ACCESS_KEY} {ALICLOUD_SECRET_KEY}"\nALICLOUD_ACCESS_KEY=ak-1\nALICLOUD_SECRET_KEY=sk-2'
assert_contains "$SANDBOX/run/Caddyfile" "dns alidns ak-1 sk-2"
assert_contains "$SANDBOX/run/app.env" "ALICLOUD_ACCESS_KEY=ak-1"   # pass-through to node (caddy reads env)
assert_contains "$SANDBOX/run/app.env" "ALICLOUD_SECRET_KEY=sk-2"

echo "== POSTGRES_PASSWORD flows into both pg-password and DATABASE_URL =="
run_init $'SOMS_DOMAIN=test.local\nPOSTGRES_PASSWORD=s3cr3t!'
assert_contains "$SANDBOX/run/pg-password" "s3cr3t!"
assert_contains "$SANDBOX/run/app.env" "timescale:s3cr3t!@postgres"

echo "== pass-through of an advanced var (excludes caddy-only keys) =="
run_init $'SOMS_DOMAIN=test.local\nCLOUDFLARE_API_TOKEN=t\nSOMS_QUOTA_DAILY_MSG_LIMIT=9000'
assert_contains "$SANDBOX/run/app.env" "SOMS_QUOTA_DAILY_MSG_LIMIT=9000"
assert_not_contains "$SANDBOX/run/app.env" "CLOUDFLARE_API_TOKEN"

echo "== missing SOMS_DOMAIN fails fast =="
expect_fail $'POSTGRES_PASSWORD=x' "SOMS_DOMAIN is required"

echo "== missing {KEY} ref fails fast =="
expect_fail $'SOMS_DOMAIN=test.local\nCADDY_DNS_DIRECTIVE="dns cloudflare {CLOUDFLARE_API_TOKEN}"' \
  "references {CLOUDFLARE_API_TOKEN} but it is not set"

echo
echo "RESULT: pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
