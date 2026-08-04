import type { FastifyReply } from 'fastify';
import type { AdminRole } from '../database/enums.js';

export type AdminPrincipal = {
  userId: number;
  adminId: number;
  role: AdminRole;
  sessionId: number;
};

/**
 * httpOnly cookie carrying the opaque admin session token. `secure: 'auto'` honors X-Forwarded-Proto
 * (main.ts explicit trusted-proxy CIDRs), so the cookie is set over TLS in prod and accepted in plain-HTTP dev — the SAME
 * pattern as the consumer `media_token` (src/auth/media-token.ts), the established convention here for an
 * opaque session cookie that must work in both environments. The name carries NO `__Host-` prefix on
 * purpose: that prefix mandates Secure, which is incompatible with `secure: 'auto'` (dev is HTTP) and
 * makes browsers reject the cookie — login appeared to succeed but the cookie was never stored, so the
 * next request 401'd and forceLogout bounced back to /admin/login.
 */
export const ADMIN_SESSION_COOKIE = 'admin_session';
const configuredHours = Number(process.env.ADMIN_SESSION_TTL_HOURS ?? 12);
export const ADMIN_SESSION_TTL_MS =
  Math.min(
    24,
    Math.max(1, Number.isFinite(configuredHours) ? configuredHours : 12),
  ) *
  60 *
  60 *
  1000;
const configuredIdleMinutes = Number(
  process.env.ADMIN_SESSION_IDLE_MINUTES ?? 60,
);
export const ADMIN_SESSION_IDLE_MS =
  configuredIdleMinutes <= 0
    ? null
    : Math.min(8 * 60, Math.max(15, configuredIdleMinutes)) * 60 * 1000;

export function setAdminSessionCookie(
  reply: FastifyReply,
  token: string,
): void {
  reply.setCookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: 'auto',
    sameSite: 'strict',
    path: '/',
    maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
  });
}

export function clearAdminSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(ADMIN_SESSION_COOKIE, {
    httpOnly: true,
    secure: 'auto',
    sameSite: 'strict',
    path: '/',
  });
}
