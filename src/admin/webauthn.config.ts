import { deriveOrigin } from '../common/origin.js';
import { getDomain } from 'tldts';

/**
 * WebAuthn relying-party configuration. Loaded once at module initialization and validated fail-fast.
 *
 * The admin console is SAME-ORIGIN with the API (Caddy serves the SPA at /admin/ and reverse-proxies
 * /api → Fastify), so there is exactly one origin to authorize. The RP ID is a registrable domain the
 * credential is scoped to; the allowed-origins list is the exact scheme://host[:port] strings that
 * @simplewebauthn/server's verifyRegistration/AuthenticationResponse accepts.
 *
 * In production, the RP ID is the Public-Suffix-List-aware registrable domain shared by SOMS_DOMAIN,
 * SOMS_WEB_DOMAIN and SOMS_LAN_DOMAIN. This lets one credential work at the public and LAN entry points
 * without operator-maintained WebAuthn settings. Different registrable domains fail startup because no
 * valid RP ID can span them. Existing explicit overrides remain supported for compatibility.
 */

const isProd = process.env.NODE_ENV === 'production';

export function loadWebAuthnConfig(
  env: NodeJS.ProcessEnv,
  production: boolean,
) {
  const overrideOrigins = env.SOMS_WEBAUTHN_ALLOWED_ORIGINS?.trim();

  const requireFrom = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing required env var: ${key}`);
    return value;
  };

  // Dev: the admin-web browser origin is http://localhost:5180 (Vite), registrable domain `localhost`.
  // Prod: derive one registrable domain shared by every configured entry point. getDomain uses the PSL,
  // so domains such as chat.example.co.uk correctly produce example.co.uk rather than co.uk.
  const identityDomain = production ? requireFrom('SOMS_DOMAIN') : 'localhost';
  const entryDomains = production
    ? [
        identityDomain,
        env.SOMS_WEB_DOMAIN?.trim() || identityDomain,
        ...(env.SOMS_LAN_DOMAIN?.trim() ? [env.SOMS_LAN_DOMAIN.trim()] : []),
      ]
    : ['localhost'];
  const registrableDomains = new Set(
    entryDomains.map((domain) => getDomain(domain) ?? domain),
  );
  if (registrableDomains.size !== 1) {
    throw new Error(
      `SOMS_DOMAIN, SOMS_WEB_DOMAIN and SOMS_LAN_DOMAIN must share one registrable domain for WebAuthn (got: ${[...registrableDomains].join(', ')})`,
    );
  }

  // Explicit override remains a compatibility escape hatch. RP IDs cannot contain a port.
  const rawRpId = env.SOMS_WEBAUTHN_RP_ID?.trim() || [...registrableDomains][0];
  const rpId = rawRpId.split(':')[0];

  const allowedOrigins = overrideOrigins
    ? overrideOrigins
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : production
      ? [
          ...new Set([
            deriveOrigin(
              env.SOMS_WEB_DOMAIN?.trim() || identityDomain,
              env.SOMS_TLS_MODE ?? 'standard',
            ),
            ...(env.SOMS_LAN_DOMAIN?.trim()
              ? [
                  deriveOrigin(
                    env.SOMS_LAN_DOMAIN.trim(),
                    env.SOMS_TLS_MODE ?? 'standard',
                  ),
                ]
              : []),
          ]),
        ]
      : ['http://localhost:5180']; // the Vite dev browser origin (localhost is a secure context)

  // WebAuthn needs a secure context. `disabled` TLS over a non-localhost origin is not secure; the
  // browser is the ultimate enforcer (window.isSecureContext), this flag is the server-side hint the
  // status endpoint surfaces so the UI can hide the passkey affordance proactively.
  const available =
    (env.SOMS_TLS_MODE ?? 'standard') !== 'disabled' || !production;

  return { rpId, allowedOrigins, available };
}

export const WEBAUTHN_CONFIG = loadWebAuthnConfig(process.env, isProd);
