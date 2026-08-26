// In-process e2e seeding helpers for the admin-provisioned login model.
//
// Self-registration is closed (PUBLIC_CONFIG.registrationOpen = false) and password login is disabled
// under APP_OTP_AND_QR, so the old register→HTTP-login seeding no longer works (and was never correct for
// OTP/QR accounts, which carry no password). These helpers insert users + sessions directly through Drizzle +
// SessionTokenService off the in-process app — the right fixtures for specs that need an authenticated
// user but don't care HOW they authenticated. For the process-boundary federation e2e, see
// federation-test-helpers.ts, which uses its own Drizzle client.
import type { INestApplication } from '@nestjs/common';
import { DatabaseService } from '../src/database/database.service';
import { relationshipIntent, user } from '../src/database/schema';
import type { Database } from '../src/database/database.service';
import {
  SessionTokenService,
  type SessionClient,
} from '../src/auth/session-token.service';
import { PasswordHasher } from '../src/auth/password-hasher.service';

export interface SeededUser {
  id: number;
  account: string;
}

/** Seed the two directed facts required for an active P2P relationship. */
export async function seedAcceptedRelationship(
  database: Database,
  firstUserId: number,
  secondUserId: number,
): Promise<void> {
  const updatedAt = new Date();
  await database.insert(relationshipIntent).values([
    {
      authorUserId: firstUserId,
      subjectUserId: secondUserId,
      status: 'ACCEPTED',
      requestedAt: updatedAt,
      updatedAt,
    },
    {
      authorUserId: secondUserId,
      subjectUserId: firstUserId,
      status: 'ACCEPTED',
      requestedAt: updatedAt,
      updatedAt,
    },
  ]);
}

/** Insert a local user directly. `password` (optional) is hashed via the app's PasswordHasher
 *  (Argon2id + pepper — the exact path /auth/login verifies against); omit it for a passwordless
 *  (OTP/QR-only) account. */
export async function seedUser(
  app: INestApplication,
  account: string,
  opts: { name?: string; password?: string } = {},
): Promise<SeededUser> {
  const database = app.get(DatabaseService);
  const [u] = await database.db
    .insert(user)
    .values({
      account,
      domain: 'local',
      name: opts.name ?? account,
      hashPwd:
        opts.password === undefined
          ? null
          : await new PasswordHasher().hash(opts.password),
      mustChangePassword: false,
      updatedAt: new Date(),
    })
    .returning({ id: user.id, account: user.account });
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
  const token = await seedSession(app, user.id, opts.client ?? 'app', {
    device: opts.device,
  });
  return { ...user, token };
}
