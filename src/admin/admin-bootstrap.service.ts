import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  account as accountTable,
  admin,
  profileTable,
} from '../database/schema.js';
import { PasswordHasher } from '../auth/password-hasher.service.js';

/**
 * Idempotent first-admin self-bootstrap. Runs once per application start via OnApplicationBootstrap
 * (which fires after DatabaseService.onModuleInit, so the DB is reachable). Ensures the
 * bootstrap admin (account=admin, namespaceId=0) exists:
 *
 *   - present            → no-op (no ADMIN_BOOTSTRAP_PASSWORD needed) — every boot after the first;
 *   - absent + password  → create the Account + a linked SUPER_ADMIN role, password hashed via the shared
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
      .from(accountTable)
      .innerJoin(admin, eq(admin.userId, accountTable.id))
      .where(eq(accountTable.account, 'admin'))
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
    // Create credentials, the initial immutable profile, and the administrative role atomically.
    // A concurrent bootstrap reuses the existing local account without changing its credentials.
    const userId = await this.database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(accountTable)
        .values({
          account: 'admin',
          namespaceId: 0,
          hashPwd: hash,
          defaultProfileRev: 1,
        })
        .onConflictDoNothing({ target: accountTable.account })
        .returning({ id: accountTable.id });
      const local =
        created ??
        (await tx.query.account.findFirst({
          where: eq(accountTable.account, 'admin'),
          columns: { id: true },
        }));
      if (!local) throw new Error('bootstrap admin account was not created');
      if (created)
        await tx.insert(profileTable).values({
          account: 'admin',
          publisherNamespaceId: 0,
          profileNamespaceId: 0,
          profileRev: 1,
          displayName: 'Admin',
          avatar: '',
          bio: '',
        });
      await tx
        .insert(admin)
        .values({
          userId: local.id,
          role: 'SUPER_ADMIN',
          enabled: true,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({ target: admin.userId });
      return local.id;
    });
    this.logger.log(
      `bootstrap admin created: account=admin userId=${userId} — change the password or unset ADMIN_BOOTSTRAP_PASSWORD after first login`,
    );
  }
}
