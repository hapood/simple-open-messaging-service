import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  account as accountTable,
  admin,
  user as userTable,
} from '../database/schema.js';
import { PasswordHasher } from '../auth/password-hasher.service.js';

/**
 * Idempotent first-admin self-bootstrap. Runs once per application start via OnApplicationBootstrap
 * (which fires after DatabaseService.onModuleInit, so the DB is reachable). Ensures the
 * bootstrap admin (account=admin, domain=local) exists:
 *
 *   - present            → no-op (no ADMIN_BOOTSTRAP_PASSWORD needed) — every boot after the first;
 *   - absent + password  → create the User + a linked SUPER_ADMIN profile, password hashed via the shared
 *                          PasswordHasher (Argon2id + pepper, the same path every login verifies against);
 *   - absent + no password → log a loud WARN and CONTINUE booting. The chat product stays up; the
 *                          operator sets ADMIN_BOOTSTRAP_PASSWORD and restarts to gain admin access.
 *
 * This is deliberately decoupled from the deploy orchestrator: it works identically under compose, k8s,
 * bare metal, or systemd — the application brings ITSELF to a manageable state. A missing/failed seed
 * never takes the chat service down; it is a best-effort, self-healing side concern that logs loudly.
 * No placeholder password is ever applied. This service is the single bootstrap path in every environment.
 */
@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureBootstrapAdmin();
    } catch (err) {
      // A transient DB blip during boot must not kill the chat product. Log loudly and continue; the
      // next successful boot (or the seed-admin.cjs escape hatch) will create the admin.
      this.logger.error(
        `bootstrap admin seeding failed (app continues without it): ${(err as Error).message}`,
      );
    }
  }

  private async ensureBootstrapAdmin(): Promise<void> {
    const [existing] = await this.database.db
      .select({ id: accountTable.id })
      .from(userTable)
      .innerJoin(accountTable, eq(accountTable.id, userTable.id))
      .innerJoin(admin, eq(admin.userId, accountTable.id))
      .where(and(eq(userTable.account, 'admin'), eq(userTable.domain, 'local')))
      .limit(1);
    if (existing) return;

    const pwd = process.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (!pwd) {
      this.logger.warn(
        'no admin account exists and ADMIN_BOOTSTRAP_PASSWORD is unset — the admin console has no login. ' +
          'Set ADMIN_BOOTSTRAP_PASSWORD and restart to create the bootstrap admin (account=admin). ' +
          'The chat service continues to run.',
      );
      return;
    }

    const hash = await this.passwordHasher.hash(pwd);
    // Identity lives on User (single account namespace); the Admin row is the linked profile. upsert with
    // update:{} absorbs the vanishing race between the findUnique above and the create (P2002-safe).
    const createdUser = await this.database.db
      .insert(userTable)
      .values({
        account: 'admin',
        name: 'admin',
        domain: 'local',
        sourceDomain: 'local',
        namespaceId: 0,
        updatedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [
          userTable.account,
          userTable.domain,
          userTable.sourceDomain,
          userTable.namespaceId,
        ],
      })
      .returning({ id: userTable.id });
    const userId =
      createdUser[0]?.id ??
      (
        await this.database.db.query.user.findFirst({
          where: and(
            eq(userTable.account, 'admin'),
            eq(userTable.domain, 'local'),
            eq(userTable.namespaceId, 0),
          ),
          columns: { id: true },
        })
      )?.id;
    if (userId === undefined)
      throw new Error('bootstrap admin user was not created');
    await this.database.db
      .insert(accountTable)
      .values({ id: userId, hashPwd: hash })
      .onConflictDoNothing({ target: accountTable.id });
    await this.database.db
      .insert(admin)
      .values({
        userId,
        role: 'SUPER_ADMIN',
        enabled: true,
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: admin.userId });
    this.logger.log(
      `bootstrap admin created: account=admin userId=${userId} — change the password or unset ADMIN_BOOTSTRAP_PASSWORD after first login`,
    );
  }
}
