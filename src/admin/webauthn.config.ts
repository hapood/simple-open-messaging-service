import { requireEnv } from '../common/env.js';
import { deriveOrigin } from '../common/origin.js';

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
 * port) via SOMS_WEBAUTHN_RP_ID / SOMS_WEBAUTHN_ALLOWED_ORIGINS. When SOMS_LAN_DOMAIN is set, its origin
 * is also added to allowed-origins (same backend) — ensure rpId is a shared registrable suffix (set
 * SOMS_WEBAUTHN_RP_ID to the apex if SOMS_DOMAIN is itself a subdomain).
 */

const isProd = process.env.NODE_ENV === 'production';
const tlsMode = process.env.SOMS_TLS_MODE ?? 'standard';

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
      ? [
          deriveOrigin(requireEnv('SOMS_DOMAIN'), tlsMode),
          // When a LAN domain is configured, admins may reach the console over it (same backend, same
          // secure context). Both domains share SOMS_DOMAIN's apex (enforced by docker/init.sh), so the
          // default rpId (= SOMS_DOMAIN) authorizes it only if SOMS_DOMAIN IS that apex; otherwise set
          // SOMS_WEBAUTHN_RP_ID to the shared apex.
          ...(process.env.SOMS_LAN_DOMAIN ? [deriveOrigin(process.env.SOMS_LAN_DOMAIN, tlsMode)] : []),
        ]
      : ['http://localhost:5180']; // the Vite dev browser origin (localhost is a secure context)

  // WebAuthn needs a secure context. `disabled` TLS over a non-localhost origin is not secure; the
  // browser is the ultimate enforcer (window.isSecureContext), this flag is the server-side hint the
  // status endpoint surfaces so the UI can hide the passkey affordance proactively.
  const available = tlsMode !== 'disabled' || !isProd;

  return { rpId, allowedOrigins, available };
}

export const WEBAUTHN_CONFIG = loadWebAuthnConfig();
