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
#
# Every config problem (missing field, bad format) is written to stderr (→ `docker compose logs init`)
# AND appended to ./data/logs/init.log so it survives `docker compose down` for post-mortem. No secret
# values are logged.
set -euo pipefail

CONFIG="${SOMS_CONFIG:-/config/soms.conf}"
RUN="${SOMS_RUN_DIR:-/soms/run}"
APPDATA_DIR="${APPDATA_DIR:-/app/data}"
PGDATA_DIR="${PGDATA_DIR:-/app/data/postgres}"
mkdir -p "$RUN" "$APPDATA_DIR/logs"
LOGFILE="$APPDATA_DIR/logs/init.log"
# The app (uid 1000) owns the logs dir so pino can write soms.log next to init.log.
chown 1000:1000 "$APPDATA_DIR/logs" 2>/dev/null || true

# log → stderr (docker logs) + persistent LOGFILE (best-effort; never abort on log-write failure).
log() {
  local msg; msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] init: $*"
  printf '%s\n' "$msg" >&2
  printf '%s\n' "$msg" >> "$LOGFILE" 2>/dev/null || true
}
die() { log "ERROR — $*"; exit 1; }

# --- Load user config (export so referenced vars are visible below) ---
[ -f "$CONFIG" ] || die "config file $CONFIG not found — bind-mount ./soms.conf into the init service"
# shellcheck disable=SC1090
set -a; . "$CONFIG"; set +a

# --- Validate required + format (fail fast with a precise message; no silent defaults for these) ---
[ -n "${SOMS_DOMAIN:-}" ] || die "SOMS_DOMAIN is required in $CONFIG"
[[ "$SOMS_DOMAIN" =~ ^[A-Za-z0-9._-]+$ ]] || die "SOMS_DOMAIN must be a bare domain (letters/digits/dot/_/- only; no scheme/port/path): '$SOMS_DOMAIN'"
case "${SOMS_TLS_MODE:-}" in
  custom|standard|disabled) ;;
  *) die "SOMS_TLS_MODE must be one of: custom | standard | disabled (got '${SOMS_TLS_MODE:-<unset>}') in $CONFIG" ;;
esac
[ -n "${POSTGRES_PASSWORD:-}" ] || die "POSTGRES_PASSWORD is required in $CONFIG"
case "$POSTGRES_PASSWORD" in
  *[@:/?#]*) die "POSTGRES_PASSWORD contains one of @ : / ? # (these break the constructed DATABASE_URL) — use a password without them" ;;
esac
[ -n "${ADMIN_BOOTSTRAP_PASSWORD:-}" ] || die "ADMIN_BOOTSTRAP_PASSWORD is required in $CONFIG"
[ -n "${DATABASE_POOL_MAX:-}" ] || die "DATABASE_POOL_MAX is required in $CONFIG"
[[ "$DATABASE_POOL_MAX" =~ ^[1-9][0-9]*$ ]] || die "DATABASE_POOL_MAX must be a positive integer: '$DATABASE_POOL_MAX'"

# CADDY_DNS_DIRECTIVE defaults to Cloudflare (the common provider) unless overridden for another.
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

# --- Resolve the DNS-01 directive (custom/standard only — disabled serves plain HTTP): transcribe each
# {KEY} ref from the config into a literal value. The referenced vars are reused below to EXCLUDE them
# from app.env (inlined into the Caddyfile, so must NOT leak into the node env). Vars NOT referenced
# (e.g. AWS_* for route53, read from process env) still pass through. ---
caddy_refs=""
if [ "$SOMS_TLS_MODE" = "disabled" ]; then
  scheme="http"
  tls_block=""
else
  scheme="https"
  directive="$CADDY_DNS_DIRECTIVE"
  for ref in $(printf '%s\n' "$directive" | grep -oE '\{[A-Z0-9_]+\}' | tr -d '{}' | sort -u); do
    val="${!ref:-}"
    [ -n "$val" ] || die "CADDY_DNS_DIRECTIVE references {$ref} but it is not set in $CONFIG"
    directive="${directive//\{$ref\}/$val}"
    caddy_refs="$caddy_refs $ref"
  done
  tls_block="$(printf '\ttls {\n\t\t%s\n\t}' "$directive")"
fi

# --- app.env: node-facing vars. Pass-through is EXCLUDE-based: drop keys emitted explicitly below,
# the caddy directive itself, and every {KEY} it referenced (caddy gets those as Caddyfile literals).
# Everything else passes through — including env-style DNS creds (AWS_* for route53) that caddy reads
# from the process env rather than the directive. ---
exclude='^(SOMS_DOMAIN|POSTGRES_PASSWORD|ADMIN_BOOTSTRAP_PASSWORD|DATABASE_POOL_MAX|CADDY_DNS_DIRECTIVE'
for ref in $caddy_refs; do exclude="$exclude|$ref"; done
exclude="$exclude)="
{
  echo "DATABASE_URL=$DATABASE_URL"
  echo "DATABASE_POOL_MAX=$DATABASE_POOL_MAX"
  echo "SOMS_DOMAIN=$SOMS_DOMAIN"
  echo "ADMIN_BOOTSTRAP_PASSWORD=$ADMIN_BOOTSTRAP_PASSWORD"
  grep -E '^[A-Z][A-Z0-9_]*=' "$CONFIG" | grep -vE "$exclude" || true
} > "$RUN/app.env"

# --- Caddyfile (self-contained). SOMS_TLS_MODE picks the edge:
#   custom    HTTPS on the compose port (7667), DNS-01 wildcard cert, no HTTP redirect.
#   standard  HTTPS on 443 + auto 80→443 redirect, AND 7667 for federation (one shared cert via snippet).
#   disabled  plain HTTP on 7667, no cert.
# The container always serves federation on canonical 7667; the published HOST port is x-host-port in
# docker-compose.yml (custom/disabled) — publish 80+443 too for standard. ---
emit_handlers() {
  printf '\tencode zstd gzip\n'
  printf '\t# Fastify origin on loopback: API (incl. SSE) + auth-gated /uploads (Caddy cannot do the cookie auth).\n'
  printf '\thandle /api* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
  printf '\thandle /uploads* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
  printf '\t# Frontend dist (baked into the image) — Caddy serves it; Fastify is API-only.\n'
  printf '\thandle /admin* {\n\t\troot * /app/public\n\t\ttry_files {path} /admin/index.html\n\t\tfile_server\n\t}\n'
  printf '\thandle {\n\t\troot * /app/public/web\n\t\ttry_files {path} /index.html\n\t\tfile_server\n\t}\n'
}
{
  if [ "$SOMS_TLS_MODE" = "standard" ]; then
    printf '{\n\tstorage file_system {\n\t\troot /app/data/caddy\n\t}\n}\n'   # no disable_redirects → auto 80→443
    printf '(soms_site) {\n%s\n' "$tls_block"
    emit_handlers
    printf '}\n'
    printf 'https://%s, https://*.%s {\n\timport soms_site\n}\n' "$SOMS_DOMAIN" "$SOMS_DOMAIN"
    printf 'https://%s:7667, https://*.%s:7667 {\n\timport soms_site\n}\n' "$SOMS_DOMAIN" "$SOMS_DOMAIN"
  else
    printf '{\n\tauto_https disable_redirects\n\tstorage file_system {\n\t\troot /app/data/caddy\n\t}\n}\n'
    printf '%s://%s:7667, %s://*.%s:7667 {\n' "$scheme" "$SOMS_DOMAIN" "$scheme" "$SOMS_DOMAIN"
    [ -n "$tls_block" ] && printf '%s\n' "$tls_block"
    emit_handlers
    printf '}\n'
  fi
} > "$RUN/Caddyfile"

chmod 644 "$RUN/pg-password" "$RUN/app.env" "$RUN/Caddyfile"
log "OK — domain=$SOMS_DOMAIN mode=$SOMS_TLS_MODE pool=$DATABASE_POOL_MAX; wrote pg-password, app.env, Caddyfile (cert=$SOMS_DOMAIN + *.$SOMS_DOMAIN)"
