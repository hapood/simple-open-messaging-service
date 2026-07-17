import { requireEnv } from '../common/env.js';

/**
 * WebAuthn relying-party configuration. Loaded once at module-init (fail-fast via requireEnv, mirroring
 * loadFederationConfig in src/federation/federation.config.ts).
 *
 * The admin console is SAME-ORIGIN with the API (Caddy serves the SPA at /admin/ and reverse-proxies
 * /api → Fastify), so there is exactly one origin to authorize. The RP ID is a registrable domain the
 * credential is scoped to; the allowed-origins list is the exact scheme://host[:port] strings that
 * @simplewebauthn/server's verifyRegistration/AuthenticationResponse accepts.
 *
 * Derivation: rpId = SOMS_DOMAIN verbatim in production (the admin is served at https://SOMS_DOMAIN/admin/,
 * so the full registered domain is the correct RP ID — no eTLD+1/PSL computation needed); in dev the
 * admin-web Vite server runs at http://localhost:5180, whose registrable domain is `localhost`, so rpId
 * defaults to `localhost` there. Both are overridable for unusual topologies (multi-subdomain, custom
 * port) via SOMS_WEBAUTHN_RP_ID / SOMS_WEBAUTHN_ALLOWED_ORIGINS.
 */

const isProd = process.env.NODE_ENV === 'production';
const tlsMode = process.env.SOMS_TLS_MODE ?? 'standard';

/** Build the single canonical browser origin for the deployment domain from the TLS mode. */
function deriveOrigin(domain: string, mode: string): string {
  switch (mode) {
    case 'disabled':
      return `http://${domain}:7667`; // plain HTTP (NOT a secure context unless localhost — see `available`)
    case 'custom':
      return `https://${domain}:7667`; // Caddy TLS on the single 7667 port (the NAS/intranet profile)
    case 'standard':
    default:
      return `https://${domain}`; // Caddy TLS on 443 (port implicit)
  }
}

function loadWebAuthnConfig() {
  const overrideOrigins = process.env.SOMS_WEBAUTHN_ALLOWED_ORIGINS?.trim();

  // Dev: the admin-web browser origin is http://localhost:5180 (Vite), registrable domain `localhost`.
  // Prod: the registered deployment domain. Explicit override always wins (multi-subdomain / custom port).
  // rpId MUST be a bare registrable domain — strip any accidental `:port` (e.g. SOMS_DOMAIN="host:7667"),
  // which would be an invalid RP ID the browser would never match.
  const rawRpId = process.env.SOMS_WEBAUTHN_RP_ID?.trim() || (isProd ? requireEnv('SOMS_DOMAIN') : 'localhost');
  const rpId = rawRpId.split(':')[0];

  const allowedOrigins = overrideOrigins
    ? overrideOrigins
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : isProd
      ? [deriveOrigin(requireEnv('SOMS_DOMAIN'), tlsMode)]
      : ['http://localhost:5180']; // the Vite dev browser origin (localhost is a secure context)

  // WebAuthn needs a secure context. `disabled` TLS over a non-localhost origin is not secure; the
  // browser is the ultimate enforcer (window.isSecureContext), this flag is the server-side hint the
  // status endpoint surfaces so the UI can hide the passkey affordance proactively.
  const available = tlsMode !== 'disabled' || !isProd;

  return { rpId, allowedOrigins, available };
}

export const WEBAUTHN_CONFIG = loadWebAuthnConfig();
