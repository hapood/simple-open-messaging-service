import { reportGeneratedJwtSecrets, resolveJwtSecret } from './jwt-secret.js';

export const jwtConstants = {
  // admin-console JWT secret — the admin system is the only remaining JWT issuer (user auth is the
  // opaque session token; no user access/refresh JWT anymore).
  adminSecret: resolveJwtSecret('JWT_ADMIN_SECRET', 'jwt-admin.key'),
  // Admin access/refresh TTLs (admin-auth.service). `as const` narrows to literals so they satisfy the
  // jwt expiresIn StringValue type.
  accessTtl: '15m' as const,
  refreshTtlDays: '14d' as const,
  refreshTtlMs: 14 * 24 * 60 * 60 * 1000,
};

// Emit one operational warning if any secret was auto-generated this boot (no-op otherwise). Run at
// module load so first-boot generation is reported before the app finishes bootstrapping.
reportGeneratedJwtSecrets();
