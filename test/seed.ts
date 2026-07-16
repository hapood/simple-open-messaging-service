// In-process e2e seeding helpers for the admin-provisioned login model.
//
// Self-registration is closed (PUBLIC_CONFIG.registrationOpen = false) and password login is disabled
// under APP_OTP_AND_QR, so the old register→HTTP-login seeding no longer works (and was never correct for
// OTP/QR accounts, which carry no password). These helpers insert users + sessions DIRECTLY — Prisma +
// SessionTokenService off the in-process app — the right fixtures for specs that need an authenticated
// user but don't care HOW they authenticated. For the process-boundary federation e2e (apps in separate
// processes), see federation-test-helpers.ts, which seeds via a test-process PrismaClient instead.
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import { PrismaService } from '../src/prisma.service';
import { SessionTokenService, type SessionClient } from '../src/auth/session-token.service';

export interface SeededUser {
  id: number;
  account: string;
}

/** Insert a local user directly. `password` (optional) is argon2-hashed into hashPwd; omit it for a
 *  passwordless (OTP/QR-only) account. */
export async function seedUser(
  app: INestApplication,
  account: string,
  opts: { name?: string; password?: string } = {},
): Promise<SeededUser> {
  const prisma = app.get(PrismaService);
  const u = await prisma.user.create({
    data: {
      account,
      domain: 'local',
      name: opts.name ?? account,
      hashPwd: opts.password === undefined ? null : await argon2.hash(opts.password),
      mustChangePassword: false,
      isForeigner: false,
    },
    select: { id: true, account: true },
  });
  return u;
}

/** Issue a session token directly via the in-process SessionTokenService. Returns the plaintext (the
 *  Bearer credential the global SessionAuthGuard validates). */
export function seedSession(
  app: INestApplication,
  userId: number,
  client: SessionClient = 'app',
  opts: { device?: string } = {},
): Promise<string> {
  return app.get(SessionTokenService).issue(userId, client, {
    device: opts.device,
    ip: '127.0.0.1',
    persistent: true,
  });
}

/** Seed a user + an authenticated session — the direct replacement for the old register+login pair.
 *  Returns { id, account, token }. */
export async function seedUserWithSession(
  app: INestApplication,
  account: string,
  opts: { name?: string; client?: SessionClient; device?: string } = {},
): Promise<SeededUser & { token: string }> {
  const user = await seedUser(app, account, { name: opts.name });
  const token = await seedSession(app, user.id, opts.client ?? 'app', { device: opts.device });
  return { ...user, token };
}
