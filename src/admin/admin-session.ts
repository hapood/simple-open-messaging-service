import type { FastifyReply } from 'fastify';
import type { AdminRole } from '../prisma/generated/client.js';

export type AdminPrincipal = { userId: number; adminId: number; role: AdminRole; sessionId: number };

export const ADMIN_SESSION_COOKIE = '__Host-admin_session';
const configuredHours = Number(process.env.ADMIN_SESSION_TTL_HOURS ?? 12);
export const ADMIN_SESSION_TTL_MS =
  Math.min(24, Math.max(1, Number.isFinite(configuredHours) ? configuredHours : 12)) * 60 * 60 * 1000;
const configuredIdleMinutes = Number(process.env.ADMIN_SESSION_IDLE_MINUTES ?? 60);
export const ADMIN_SESSION_IDLE_MS =
  configuredIdleMinutes <= 0
    ? null
    : Math.min(8 * 60, Math.max(15, configuredIdleMinutes)) * 60 * 1000;

export function setAdminSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
  });
}

export function clearAdminSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(ADMIN_SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
  });
}
