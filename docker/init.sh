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
# Admin area exposure. `public` (default) leaves /admin + /api/v1/admin open to all; `lan` restricts both to
# private-range IPs (a @not_lan guard in the Caddyfile — see emit_handlers). Backward-compatible: an existing
# soms.conf without this var stays open.
case "${SOMS_ADMIN_ACCESS:-public}" in
  public|lan) ;;
  *) die "SOMS_ADMIN_ACCESS must be one of: public | lan (got '${SOMS_ADMIN_ACCESS:-<unset>}') in $CONFIG" ;;
esac
# Registrable-domain (apex) of a bare hostname — last 2 labels. Used to enforce that SOMS_LAN_DOMAIN shares
# SOMS_DOMAIN's apex (both are certified via ONE DNS-01 provider/zone). Multi-label TLDs (co.uk) reduce
# accuracy; the common subdomain case is covered and operators know their topology.
apex_of() {
  local d="$1"
  if [ "$(awk -F. '{print NF}' <<<"$d")" -ge 2 ]; then awk -F. '{print $(NF-1)"."$NF}' <<<"$d"; else printf '%s' "$d"; fi
}

# LAN domain — an alternate real domain (own DNS-01 cert) fronting the SAME backend, so native clients can
# reach the box from inside the LAN when the public domain is hairpin-NAT-unreachable. Replaces the old
# SOMS_ALLOW_IP_ACCESS self-signed IP catch-all (which broke iOS PWA: SW/Push require a trusted cert).
# Optional; when set it MUST share SOMS_DOMAIN's apex (both certified via the same single DNS-01 zone).
if [ -n "${SOMS_LAN_DOMAIN:-}" ]; then
  [[ "$SOMS_LAN_DOMAIN" =~ ^[A-Za-z0-9._-]+$ ]] || die "SOMS_LAN_DOMAIN must be a bare domain (letters/digits/dot/_/- only; no scheme/port/path): '$SOMS_LAN_DOMAIN'"
  if [ "$(apex_of "$SOMS_DOMAIN")" != "$(apex_of "$SOMS_LAN_DOMAIN")" ]; then
    die "SOMS_LAN_DOMAIN ('$SOMS_LAN_DOMAIN' → $(apex_of "$SOMS_LAN_DOMAIN")) must share SOMS_DOMAIN's registrable domain ('$SOMS_DOMAIN' → $(apex_of "$SOMS_DOMAIN")) — both are certified via one DNS-01 provider/zone (CADDY_DNS_DIRECTIVE). Use a subdomain of the same apex."
  fi
fi
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
exclude='^(SOMS_DOMAIN|POSTGRES_PASSWORD|ADMIN_BOOTSTRAP_PASSWORD|DATABASE_POOL_MAX|CADDY_DNS_DIRECTIVE|SOMS_ADMIN_ACCESS'
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
#             + SOMS_LAN_DOMAIN set → ALSO an https://<lan-domain>:7667 site (own DNS-01 cert, same zone).
#   standard  HTTPS on 443 + auto 80→443 redirect, AND 7667 for federation (one shared cert via snippet).
#             + SOMS_LAN_DOMAIN set → additional https://<lan-domain> sites (own DNS-01 cert).
#   disabled  plain HTTP on 7667, no cert (+ http://<lan-domain>:7667 if SOMS_LAN_DOMAIN set).
# SOMS_ADMIN_ACCESS=lan layers a @not_lan guard onto the admin area (page + API) in every mode.
# The container always serves federation on canonical 7667; the published HOST port is x-host-port in
# docker-compose.yml (custom/disabled) — publish 80+443 too for standard. ---
# The route handlers shared by every site. When SOMS_ADMIN_ACCESS=lan the admin page (/admin) and admin API
# (/api/v1/admin) are gated to private IPs: @not_lan is defined once and reused by both admin handles, and
# `respond @not_lan 403` short-circuits non-LAN clients. handle blocks are source-ordered / first-match /
# terminal, so the guard precedes reverse_proxy/file_server with no Caddy directive-reorder risk; remote_ip
# sees the real client because Caddy is the edge here (no front proxy in the single-image stack). The public
# branch is byte-identical to the pre-guard output (no var set → no change for existing deploys).
emit_handlers() {
  printf '\tencode zstd gzip\n'
  if [ "${SOMS_ADMIN_ACCESS:-public}" = "lan" ]; then
    printf '\t@not_lan not remote_ip 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.1 ::1 fc00::/7 fe80::/10\n'
    printf '\t# Admin API + admin page - LAN-only (403 otherwise); MUST precede the generic /api* handle.\n'
    printf '\thandle /api/v1/admin* {\n\t\trespond @not_lan 403\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
    printf '\thandle /admin* {\n\t\trespond @not_lan 403\n\t\troot * /app/public\n\t\ttry_files {path} /admin/index.html\n\t\tfile_server\n\t}\n'
    printf '\t# Fastify origin on loopback: consumer API (incl. SSE) + auth-gated /uploads.\n'
    printf '\thandle /api* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
    printf '\thandle /uploads* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
  else
    printf '\t# Fastify origin on loopback: API (incl. SSE) + auth-gated /uploads (Caddy cannot do the cookie auth).\n'
    printf '\thandle /api* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
    printf '\thandle /uploads* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
    printf '\t# Frontend dist (baked into the image) — Caddy serves it; Fastify is API-only.\n'
    printf '\thandle /admin* {\n\t\troot * /app/public\n\t\ttry_files {path} /admin/index.html\n\t\tfile_server\n\t}\n'
  fi
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
    # LAN domain (own DNS-01 cert via the same provider/zone) — only when configured.
    if [ -n "${SOMS_LAN_DOMAIN:-}" ]; then
      printf 'https://%s, https://*.%s {\n\timport soms_site\n}\n' "$SOMS_LAN_DOMAIN" "$SOMS_LAN_DOMAIN"
      printf 'https://%s:7667, https://*.%s:7667 {\n\timport soms_site\n}\n' "$SOMS_LAN_DOMAIN" "$SOMS_LAN_DOMAIN"
    fi
  else
    printf '{\n\tauto_https disable_redirects\n\tstorage file_system {\n\t\troot /app/data/caddy\n\t}\n}\n'
    printf '%s://%s:7667, %s://*.%s:7667 {\n' "$scheme" "$SOMS_DOMAIN" "$scheme" "$SOMS_DOMAIN"
    [ -n "$tls_block" ] && printf '%s\n' "$tls_block"
    emit_handlers
    printf '}\n'
    # LAN domain (own DNS-01 cert via the same provider/zone) — only when configured. `disabled` mode serves
    # it over plain HTTP (tls_block empty); custom mints a cert via the same tls_block.
    if [ -n "${SOMS_LAN_DOMAIN:-}" ]; then
      printf '%s://%s:7667, %s://*.%s:7667 {\n' "$scheme" "$SOMS_LAN_DOMAIN" "$scheme" "$SOMS_LAN_DOMAIN"
      [ -n "$tls_block" ] && printf '%s\n' "$tls_block"
      emit_handlers
      printf '}\n'
    fi
  fi
} > "$RUN/Caddyfile"

chmod 644 "$RUN/pg-password" "$RUN/app.env" "$RUN/Caddyfile"
log "OK — domain=$SOMS_DOMAIN lan-domain=${SOMS_LAN_DOMAIN:-none} mode=$SOMS_TLS_MODE admin=${SOMS_ADMIN_ACCESS:-public} pool=$DATABASE_POOL_MAX; wrote pg-password, app.env, Caddyfile"
