/**
 * Canonical client/browser origin for a deployment domain, derived from SOMS_TLS_MODE — the edge Caddy
 * config that docker/init.sh generated. One source of truth for the scheme+port scheme, shared by
 * /client/compat (advertising origins to the native shell for symmetric auto-fill) and WebAuthn
 * (allowed-origins). Mirrors the bash site-emission scheme in docker/init.sh.
 *
 *   standard → https://<domain>        (Caddy on 443, port implicit)
 *   single-port → https://<domain>:7667 (Caddy TLS on the single 7667 port — the NAS/intranet profile)
 *   disabled → http://<domain>:7667    (plain HTTP — NOT a secure context unless localhost)
 *
 * `tlsMode` defaults to the process env so most callers omit it; WebAuthn passes its already-read value.
 */
export function deriveOrigin(
  domain: string,
  tlsMode: string = process.env.SOMS_TLS_MODE ?? 'standard',
): string {
  switch (tlsMode) {
    case 'disabled':
      return `http://${domain}:7667`;
    case 'single-port':
      return `https://${domain}:7667`;
    case 'standard':
    default:
      return `https://${domain}`;
  }
}
