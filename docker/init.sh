#!/usr/bin/env bash
# Custom Docker init (runs in the `init` one-shot service, as root). Reads /config/soms.conf, validates
# it, and generates the runtime artifacts the other services consume from /soms/run:
#   pg-password  raw postgres password   -> postgres POSTGRES_PASSWORD_FILE
#   app.env      node-facing env          -> app/migrate entrypoint sources it (incl. the constructed DATABASE_URL)
#   Caddyfile    self-contained edge cfg  -> app's caddy (concrete values; caddy needs no process env)
#
# Also prepares ./data/postgres ownership: postgres runs as uid 999 but the host dir is uid 1000, so
# init (root) chowns it 999:999. Idempotent — safe on every boot, including existing DBs.
#
# Provider-agnostic: the cert DNS line comes from CADDY_DNS_DIRECTIVE (default Cloudflare); any {KEY}
# references are transcribed from the config, so this script never encodes a provider's credential shape.
set -euo pipefail

CONFIG="${SOMS_CONFIG:-/config/soms.conf}"
RUN="${SOMS_RUN_DIR:-/soms/run}"
APPDATA_DIR="${APPDATA_DIR:-/app/data}"
PGDATA_DIR="${PGDATA_DIR:-/app/data/postgres}"
mkdir -p "$RUN"

# --- Load user config (export so referenced vars are visible below) ---
[ -f "$CONFIG" ] || { echo "init: config file $CONFIG not found — bind-mount ./soms.conf into the init service" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$CONFIG"; set +a

# --- Validate required ---
[ -n "${SOMS_DOMAIN:-}" ] || { echo "init: SOMS_DOMAIN is required in $CONFIG" >&2; exit 1; }

# --- Defaults ---
: "${SOMS_PUBLIC_HOST:=$SOMS_DOMAIN}"
: "${POSTGRES_PASSWORD:=change-me}"
: "${DATABASE_POOL_MAX:=10}"
# Default set via an explicit test (not `${var:=...}`): the value contains '}', which would terminate a
# `${...:=...}` expansion early and truncate the default.
if [ -z "${CADDY_DNS_DIRECTIVE:-}" ]; then
  CADDY_DNS_DIRECTIVE='dns cloudflare {CLOUDFLARE_API_TOKEN}'
fi

# --- Prepare data-dir ownership. Under ./data (bind-mounted at /app/data): app state is owned by node
# --- (uid 1000); ./data/postgres is owned by postgres (uid 999). Non-recursive on the parent so the
# --- postgres subdir keeps its own owner. Idempotent — safe on every boot, incl. existing DBs.
mkdir -p "$APPDATA_DIR" "$PGDATA_DIR"
chown 1000:1000 "$APPDATA_DIR"
chown -R 999:999 "$PGDATA_DIR"

# --- Construct DATABASE_URL from POSTGRES_PASSWORD (single source of truth — set the password once) ---
DATABASE_URL="postgresql://timescale:${POSTGRES_PASSWORD}@postgres:5432/soms?schema=public"

# --- pg-password (raw, for POSTGRES_PASSWORD_FILE) ---
printf '%s' "$POSTGRES_PASSWORD" > "$RUN/pg-password"

# --- app.env: node-facing vars (constructed DATABASE_URL + pass-through of advanced vars). ---
# Excluded from pass-through: keys emitted explicitly below, and caddy/structural-only keys.
{
  echo "DATABASE_URL=$DATABASE_URL"
  echo "DATABASE_POOL_MAX=$DATABASE_POOL_MAX"
  echo "SOMS_DOMAIN=$SOMS_DOMAIN"
  echo "ADMIN_BOOTSTRAP_PASSWORD=${ADMIN_BOOTSTRAP_PASSWORD:-}"
  grep -E '^[A-Z][A-Z0-9_]*=' "$CONFIG" \
    | grep -vE '^(SOMS_DOMAIN|SOMS_PUBLIC_HOST|POSTGRES_PASSWORD|ADMIN_BOOTSTRAP_PASSWORD|DATABASE_POOL_MAX|CLOUDFLARE_API_TOKEN|CADDY_DNS_DIRECTIVE)=' \
    || true
} > "$RUN/app.env"

# --- Caddyfile (self-contained). ---
# SOMS_DISABLE_TLS=1 -> serve plain HTTP (no tls block, no DNS-01 cert provisioning): local testing, or
# TLS terminated by an outer reverse proxy. Default (unset/0) -> HTTPS + DNS-01 cert via CADDY_DNS_DIRECTIVE.
if [ "${SOMS_DISABLE_TLS:-0}" = "1" ]; then
  scheme="http"
  tls_block=""
else
  scheme="https"
  directive="$CADDY_DNS_DIRECTIVE"
  for ref in $(printf '%s\n' "$directive" | grep -oE '\{[A-Z0-9_]+\}' | tr -d '{}' | sort -u); do
    val="${!ref:-}"
    [ -n "$val" ] || { echo "init: CADDY_DNS_DIRECTIVE references {$ref} but it is not set in $CONFIG" >&2; exit 1; }
    directive="${directive//\{$ref\}/$val}"
  done
  tls_block="$(printf '\ttls {\n\t\t%s\n\t}' "$directive")"
fi
{
  printf '{\n\tauto_https disable_redirects\n\tstorage file_system {\n\t\troot /app/data/caddy\n\t}\n}\n'
  printf '%s://%s:7667 {\n' "$scheme" "$SOMS_PUBLIC_HOST"
  [ -n "$tls_block" ] && printf '%s\n' "$tls_block"
  printf '\tencode zstd gzip\n'
  printf '\t# Fastify origin on loopback: API (incl. SSE) + auth-gated /uploads (Caddy cannot do the cookie auth).\n'
  printf '\thandle /api* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
  printf '\thandle /uploads* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
  printf '\t# Frontend dist (baked into the image) — Caddy serves it; Fastify is API-only.\n'
  printf '\thandle /admin* {\n\t\troot * /app/public\n\t\ttry_files {path} /admin/index.html\n\t\tfile_server\n\t}\n'
  printf '\thandle {\n\t\troot * /app/public/web\n\t\ttry_files {path} /index.html\n\t\tfile_server\n\t}\n'
  printf '}\n'
} > "$RUN/Caddyfile"

chmod 644 "$RUN/pg-password" "$RUN/app.env" "$RUN/Caddyfile"
echo "init: wrote pg-password, app.env, Caddyfile (host=$SOMS_PUBLIC_HOST)"
