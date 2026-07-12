import { reportGeneratedJwtSecrets, resolveJwtSecret } from './jwt-secret.js';

export const jwtConstants = {
  // access_token signing/verification secret (JwtModule, JwtStrategy, WebSocket gateway).
  accessSecret: resolveJwtSecret('JWT_ACCESS_SECRET', 'jwt-access.key'),
  // refresh_token signing/verification secret (AuthService only; kept separate from access).
  refreshSecret: resolveJwtSecret('JWT_REFRESH_SECRET', 'jwt-refresh.key'),
  // admin-console JWT secret (physically isolated from the user system).
  adminSecret: resolveJwtSecret('JWT_ADMIN_SECRET', 'jwt-admin.key'),
  // TTLs centralized here to avoid scattered magic strings/numbers. `as const` narrows to literals
  // so they satisfy the jwt expiresIn StringValue type.
  accessTtl: '15m' as const,
  accessTtlSec: 15 * 60,
  refreshTtlDays: '14d' as const,
  refreshTtlMs: 14 * 24 * 60 * 60 * 1000,
};

// Emit one operational warning if any secret was auto-generated this boot (no-op otherwise). Run at
// module load so first-boot generation is reported before the app finishes bootstrapping.
reportGeneratedJwtSecrets();
