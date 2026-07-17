import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { AdminRole } from '../prisma/generated/client.js';
import { PasswordHasher } from '../auth/password-hasher.service.js';

/**
 * Idempotent first-admin self-bootstrap. Runs once per application start via OnApplicationBootstrap
 * (which fires AFTER PrismaService.onModuleInit → $connect, so the DB is reachable). Ensures the
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
 * No placeholder password is ever applied. The `prisma/seed-admin.cjs` script remains as a local-dev /
 * escape hatch (same logic via dotenv) for when the operator wants to force a re-seed out of band.
 */
@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(private readonly prisma: PrismaService, private readonly passwordHasher: PasswordHasher) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureBootstrapAdmin();
    } catch (err) {
      // A transient DB blip during boot must not kill the chat product. Log loudly and continue; the
      // next successful boot (or the seed-admin.cjs escape hatch) will create the admin.
      this.logger.error(`bootstrap admin seeding failed (app continues without it): ${(err as Error).message}`);
    }
  }

  private async ensureBootstrapAdmin(): Promise<void> {
    const existing = await this.prisma.user.findUnique({
      where: { account_domain: { account: 'admin', domain: 'local' } },
      select: { id: true },
    });
    if (existing) return; // already manageable — idempotent no-op on every boot after the first

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
    const user = await this.prisma.user.upsert({
      where: { account_domain: { account: 'admin', domain: 'local' } },
      update: {},
      create: { account: 'admin', hashPwd: hash, name: 'admin', isForeigner: false, domain: 'local' },
    });
    await this.prisma.admin.upsert({
      where: { userId: user.id },
      update: {},
      // role/enabled match the schema defaults; stated explicitly to document bootstrap intent.
      create: { userId: user.id, role: AdminRole.SUPER_ADMIN, enabled: true },
    });
    this.logger.log(
      `bootstrap admin created: account=admin userId=${user.id} — change the password or unset ADMIN_BOOTSTRAP_PASSWORD after first login`,
    );
  }
}
