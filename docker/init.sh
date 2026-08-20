#!/usr/bin/env bash
# Runtime configuration renderer. It validates the environment injected by Compose and writes the
# Caddyfile used by the app container. No deployment config is sourced as shell code and no generated
# environment/password files are shared between containers.
#
# Provider-agnostic: the cert DNS line comes from CADDY_DNS_DIRECTIVE (default Cloudflare); any {KEY}
# references are transcribed from the config, so this script never encodes a provider's credential shape.
#
# Every config problem is written to stderr and therefore appears in `docker compose logs app`.
set -euo pipefail

RUN="${SOMS_RUN_DIR:-/tmp/soms}"
CADDYFILE="${CADDYFILE:-$RUN/Caddyfile}"
mkdir -p "$RUN"

log() {
  local msg; msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] init: $*"
  printf '%s\n' "$msg" >&2
}
die() { log "ERROR — $*"; exit 1; }

# --- Validate required + format (fail fast with a precise message; no silent defaults for these) ---
[ -n "${SOMS_DOMAIN:-}" ] || die "SOMS_DOMAIN is required"
[[ "$SOMS_DOMAIN" =~ ^[A-Za-z0-9._-]+$ ]] || die "SOMS_DOMAIN must be a bare domain (letters/digits/dot/_/- only; no scheme/port/path): '$SOMS_DOMAIN'"
case "${SOMS_TLS_MODE:-}" in
  single-port|standard|disabled) ;;
  *) die "SOMS_TLS_MODE must be one of: single-port | standard | disabled (got '${SOMS_TLS_MODE:-<unset>}')" ;;
esac
# This image always runs Caddy as its only TLS edge and connects to the Node origin over loopback HTTP.
# Direct Fastify TLS would make that upstream protocol (and the container healthcheck) disagree with Node.
if [ -n "${TLS_CERT:-}" ] || [ -n "${TLS_KEY:-}" ]; then
  if [ "$SOMS_TLS_MODE" = "standard" ] || [ "$SOMS_TLS_MODE" = "single-port" ]; then
    die "conflicting TLS configuration: TLS_CERT/TLS_KEY cannot be used with Caddy automatic DNS-01 TLS (SOMS_TLS_MODE=$SOMS_TLS_MODE); remove TLS_CERT and TLS_KEY"
  fi
  die "TLS_CERT and TLS_KEY are unsupported in the full Docker image because Caddy requires a plaintext loopback origin; remove TLS_CERT and TLS_KEY"
fi
# Admin area exposure. `public` (default) leaves /admin + /api/v1/admin open to all; `lan` restricts both to
# private-range IPs (a @not_lan guard in the Caddyfile — see emit_handlers). Backward-compatible: an existing
# .env without this var stays open.
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

# Whether a hostname is already matched by the identity site's exact host or one-label wildcard.
# Example: SOMS_DOMAIN=example.com already covers chat.example.com via *.example.com, so emitting a second Caddy
# site for SOMS_WEB_DOMAIN would be redundant. A sibling of a subdomain is not covered.
covered_by_identity_site() {
  local candidate="$1" prefix
  [ "$candidate" = "$SOMS_DOMAIN" ] && return 0
  case "$candidate" in
    *."$SOMS_DOMAIN")
      prefix="${candidate%."$SOMS_DOMAIN"}"
      [[ "$prefix" != *.* ]]
      ;;
    *) return 1 ;;
  esac
}

# Public client/Web entry domain. Federation identity remains SOMS_DOMAIN; this only separates the
# advertised browser/native origin from @user@domain handles. Omitted = use SOMS_DOMAIN (backward compatible).
if [ -n "${SOMS_WEB_DOMAIN:-}" ]; then
  [[ "$SOMS_WEB_DOMAIN" =~ ^[A-Za-z0-9._-]+$ ]] || die "SOMS_WEB_DOMAIN must be a bare domain (letters/digits/dot/_/- only; no scheme/port/path): '$SOMS_WEB_DOMAIN'"
  if [ "$(apex_of "$SOMS_DOMAIN")" != "$(apex_of "$SOMS_WEB_DOMAIN")" ]; then
    die "SOMS_WEB_DOMAIN ('$SOMS_WEB_DOMAIN') must share SOMS_DOMAIN's registrable domain ('$SOMS_DOMAIN')"
  fi
fi

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
# CADDY_DNS_DIRECTIVE defaults to Cloudflare (the common provider) unless overridden for another.
# Default set via an explicit test (not `${var:=...}`): the value contains '}', which would terminate a
# `${...:=...}` expansion early and truncate the default.
if [ -z "${CADDY_DNS_DIRECTIVE:-}" ]; then
  CADDY_DNS_DIRECTIVE='dns cloudflare {CLOUDFLARE_API_TOKEN}'
fi

# --- Resolve the DNS-01 directive (single-port/standard only — disabled serves plain HTTP): transcribe each
# {KEY} ref from the environment into a literal value. Providers such as Route 53 may instead read
# their credentials directly from the Caddy process environment. ---
caddy_refs=""
if [ "$SOMS_TLS_MODE" = "disabled" ]; then
  scheme="http"
  tls_block=""
else
  scheme="https"
  directive="$CADDY_DNS_DIRECTIVE"
  for ref in $(printf '%s\n' "$directive" | grep -oE '\{[A-Z0-9_]+\}' | tr -d '{}' | sort -u); do
    val="${!ref:-}"
    [ -n "$val" ] || die "CADDY_DNS_DIRECTIVE references {$ref} but it is not set"
    directive="${directive//\{$ref\}/$val}"
    caddy_refs="$caddy_refs $ref"
  done
  tls_block="$(printf '\ttls {\n\t\t%s\n\t}' "$directive")"
fi

# --- Caddyfile (self-contained). SOMS_TLS_MODE picks the edge:
#   single-port  HTTPS on the compose port (7667), DNS-01 wildcard cert, no HTTP redirect.
#             + SOMS_LAN_DOMAIN set → ALSO an https://<lan-domain>:7667 site (own DNS-01 cert, same zone).
#   standard  HTTPS on 443 + auto 80→443 redirect, AND 7667 for federation (one shared cert via snippet).
#             + SOMS_LAN_DOMAIN set → additional https://<lan-domain> sites (own DNS-01 cert).
#   disabled  plain HTTP on 7667, no cert (+ http://<lan-domain>:7667 if SOMS_LAN_DOMAIN set).
# SOMS_ADMIN_ACCESS=lan layers a @not_lan guard onto the admin area (page + API) in every mode.
# The container always serves federation on canonical 7667; the published HOST port is x-host-port in
# docker-compose.yml (single-port/disabled) — publish 80+443 too for standard. ---
# The route handlers shared by every site. When SOMS_ADMIN_ACCESS=lan the admin page (/admin) and admin API
# (/api/v1/admin) are gated to private IPs: @not_lan is defined once and reused by both admin handles, and
# `respond @not_lan 403` short-circuits non-LAN clients. handle blocks are source-ordered / first-match /
# terminal, so the guard precedes reverse_proxy/file_server with no Caddy directive-reorder risk; remote_ip
# sees the real client because Caddy is the edge here (no front proxy in the single-image stack). The public
# branch is byte-identical to the pre-guard output (no var set → no change for existing deploys).
emit_static_files() {
  local root="$1" fallback="$2" matcher="$3"
  printf '\t\troute {\n'
  printf '\t\t\troot * %s\n' "$root"
  printf '\t\t\ttry_files {path} %s\n' "$fallback"
  printf '\t\t\theader Cache-Control "no-cache"\n'
  printf '\t\t\t@%s path_regexp %s -[A-Za-z0-9_-]{8}\\.[^/]+$\n' "$matcher" "$matcher"
  printf '\t\t\theader @%s Cache-Control "public, max-age=31536000, immutable"\n' "$matcher"
  printf '\t\t\tfile_server\n'
  printf '\t\t}\n'
}

emit_handlers() {
  printf '\tencode zstd gzip\n'
  printf '\t# Federation discovery is served by Fastify, not the SPA fallback.\n'
  printf '\thandle /.well-known/* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
  if [ "${SOMS_ADMIN_ACCESS:-public}" = "lan" ]; then
    printf '\t@not_lan not remote_ip 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.1 ::1 fc00::/7 fe80::/10\n'
    printf '\t# Admin API + admin page - LAN-only (403 otherwise); MUST precede the generic /api* handle.\n'
    printf '\thandle /api/v1/admin* {\n\t\trespond @not_lan 403\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
    printf '\t# React Router uses /admin/ as its basename; canonicalize the bare mount before serving the SPA.\n'
    printf '\thandle /admin {\n\t\troute {\n\t\t\trespond @not_lan 403\n\t\t\tredir * /admin/ 308\n\t\t}\n\t}\n'
    printf '\thandle /admin* {\n\t\trespond @not_lan 403\n'
    emit_static_files /app/public /admin/index.html admin_immutable
    printf '\t}\n'
    printf '\t# Fastify origin on loopback: consumer API (incl. SSE) + auth-gated /uploads.\n'
    printf '\thandle /api* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
    printf '\thandle /uploads* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
  else
    printf '\t# Fastify origin on loopback: API (incl. SSE) + auth-gated /uploads (Caddy cannot do the cookie auth).\n'
    printf '\thandle /api* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
    printf '\thandle /uploads* {\n\t\treverse_proxy 127.0.0.1:3000\n\t}\n'
    printf '\t# Frontend dist (baked into the image) — Caddy serves it; Fastify is API-only.\n'
    printf '\tredir /admin /admin/ 308\n'
    printf '\thandle /admin* {\n'
    emit_static_files /app/public /admin/index.html admin_immutable
    printf '\t}\n'
  fi
  printf '\thandle {\n'
  emit_static_files /app/public/web /index.html web_immutable
  printf '\t}\n'
}
{
  if [ "$SOMS_TLS_MODE" = "standard" ]; then
    printf '{\n\tstorage file_system {\n\t\troot /app/data/caddy\n\t}\n}\n'   # no disable_redirects → auto 80→443
    printf '(soms_site) {\n%s\n' "$tls_block"
    emit_handlers
    printf '}\n'
    printf 'https://%s, https://*.%s {\n\timport soms_site\n}\n' "$SOMS_DOMAIN" "$SOMS_DOMAIN"
    printf 'https://%s:7667, https://*.%s:7667 {\n\timport soms_site\n}\n' "$SOMS_DOMAIN" "$SOMS_DOMAIN"
    if [ -n "${SOMS_WEB_DOMAIN:-}" ] && ! covered_by_identity_site "$SOMS_WEB_DOMAIN"; then
      printf 'https://%s {\n\timport soms_site\n}\n' "$SOMS_WEB_DOMAIN"
      printf 'https://%s:7667 {\n\timport soms_site\n}\n' "$SOMS_WEB_DOMAIN"
    fi
    # LAN domain (own DNS-01 cert via the same provider/zone) — only when configured.
    if [ -n "${SOMS_LAN_DOMAIN:-}" ] && ! covered_by_identity_site "$SOMS_LAN_DOMAIN"; then
      printf 'https://%s, https://*.%s {\n\timport soms_site\n}\n' "$SOMS_LAN_DOMAIN" "$SOMS_LAN_DOMAIN"
      printf 'https://%s:7667, https://*.%s:7667 {\n\timport soms_site\n}\n' "$SOMS_LAN_DOMAIN" "$SOMS_LAN_DOMAIN"
    fi
  else
    printf '{\n\tauto_https disable_redirects\n\tstorage file_system {\n\t\troot /app/data/caddy\n\t}\n}\n'
    printf '%s://%s:7667, %s://*.%s:7667 {\n' "$scheme" "$SOMS_DOMAIN" "$scheme" "$SOMS_DOMAIN"
    [ -n "$tls_block" ] && printf '%s\n' "$tls_block"
    emit_handlers
    printf '}\n'
    if [ -n "${SOMS_WEB_DOMAIN:-}" ] && ! covered_by_identity_site "$SOMS_WEB_DOMAIN"; then
      printf '%s://%s:7667 {\n' "$scheme" "$SOMS_WEB_DOMAIN"
      [ -n "$tls_block" ] && printf '%s\n' "$tls_block"
      emit_handlers
      printf '}\n'
    fi
    # LAN domain (own DNS-01 cert via the same provider/zone) — only when configured. `disabled` mode serves
    # it over plain HTTP (tls_block empty); single-port mints a cert via the same tls_block.
    if [ -n "${SOMS_LAN_DOMAIN:-}" ] && ! covered_by_identity_site "$SOMS_LAN_DOMAIN"; then
      printf '%s://%s:7667, %s://*.%s:7667 {\n' "$scheme" "$SOMS_LAN_DOMAIN" "$scheme" "$SOMS_LAN_DOMAIN"
      [ -n "$tls_block" ] && printf '%s\n' "$tls_block"
      emit_handlers
      printf '}\n'
    fi
  fi
} > "$CADDYFILE"

chmod 600 "$CADDYFILE"
log "OK — domain=$SOMS_DOMAIN web-domain=${SOMS_WEB_DOMAIN:-$SOMS_DOMAIN} lan-domain=${SOMS_LAN_DOMAIN:-none} mode=$SOMS_TLS_MODE admin=${SOMS_ADMIN_ACCESS:-public}; wrote $CADDYFILE"
