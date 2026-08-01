import { Injectable } from '@nestjs/common';
import { count, desc, eq, ilike, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { admin, user } from '../database/schema.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminRole } from '../database/enums.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type {
  AdminManageListDto,
  AdminCreateDto,
  AdminSetRoleDto,
} from './admin.dto.js';

type StateChange = { kind: 'disable' } | { kind: 'role'; role: AdminRole };

/**
 * Admin self-management domain logic: list, promote, disable/enable, role change.
 *
 * The last-super guard is RACE-FREE. disable / demote of an enabled SUPER_ADMIN runs inside a
 * $transaction that SELECT ... FOR UPDATE-locks every enabled super row before counting, so two
 * super-admins disabling each other concurrently cannot drive the enabled-super count to 0: the
 * second transaction blocks on the row lock, then re-reads the post-commit count and refuses. A
 * real state change (an actual disable, or a role transition) is followed by revokeSessionsByAdmin
 * so the affected admin's outstanding admin_session cookies fail validation on their next request;
 * a no-op same-role setRole (or disabling an already-disabled admin) changes nothing and revokes
 * nothing, so it never kicks the admin.
 *
 * Errors throw BusinessException (the controller propagates → global AllExceptionsFilter renders
 * HTTP 200 + code); success returns the raw payload (list / created admin), and ack-only ops
 * (disable / enable / setRole / resetTwoFactor) return void.
 */
@Injectable()
export class AdminManageService {
  constructor(
    private readonly database: DatabaseService,
    private readonly adminAuth: AdminAuthService,
  ) {}

  async list(dto: AdminManageListDto) {
    const where = dto.search
      ? ilike(user.account, `%${dto.search}%`)
      : undefined;
    const [rows, total] = await Promise.all([
      this.database.db
        .select({
          id: admin.id,
          userId: admin.userId,
          role: admin.role,
          enabled: admin.enabled,
          twoFactorEnabled: admin.twoFactorEnabled,
          lastLoginAt: admin.lastLoginAt,
          lastLoginIp: admin.lastLoginIp,
          createdAt: admin.createdAt,
          account: user.account,
          name: user.name,
        })
        .from(admin)
        .innerJoin(user, eq(user.id, admin.userId))
        .where(where)
        .orderBy(desc(admin.createdAt))
        .offset(dto.skip ?? 0)
        .limit(dto.take ?? 50),
      this.database.db
        .select({ value: count() })
        .from(admin)
        .innerJoin(user, eq(user.id, admin.userId))
        .where(where)
        .then(([row]) => row.value),
    ]);
    // Flatten user.account/name onto the row so the response is a flat admin record.
    const list = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      account: r.account,
      name: r.name,
      role: r.role,
      enabled: r.enabled,
      twoFactorEnabled: r.twoFactorEnabled,
      lastLoginAt: r.lastLoginAt,
      lastLoginIp: r.lastLoginIp,
      createdAt: r.createdAt,
    }));
    return { list, total };
  }

  async create(dto: AdminCreateDto) {
    const candidate = await this.database.db.query.user.findFirst({
      where: eq(user.id, dto.userId),
      columns: { isGroup: true, isDeleted: true },
      with: { admins: { columns: { id: true } } },
    });
    if (!candidate)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'user not found');
    if (candidate.isGroup) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'a group account cannot become an admin',
      );
    }
    if (candidate.isDeleted) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'a deleted user cannot become an admin',
      );
    }
    if (candidate.admins.length > 0) {
      throw new BusinessException(
        BusinessCode.ALREADY_EXISTS,
        'user is already an admin',
      );
    }
    return this.database.db
      .insert(admin)
      .values({ userId: dto.userId, role: dto.role, updatedAt: new Date() })
      .returning({ id: admin.id, userId: admin.userId, role: admin.role })
      .then(([row]) => row);
  }

  async disable(adminId: number): Promise<void> {
    const { changed } = await this.guardedStateChange(adminId, {
      kind: 'disable',
    });
    // Revoke outstanding sessions only on a real disable (the admin was enabled) — deleting the linked
    // AdminSession rows is what invalidates their admin_session cookie on the next request.
    if (changed)
      await this.adminAuth.revokeSessionsByAdmin(adminId, 'admin_disabled');
  }

  async enable(adminId: number): Promise<void> {
    const existing = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: { id: true },
    });
    if (!existing)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'admin not found');
    // No session revocation: a disabled admin's sessions were already revoked at disable time and none
    // can be created while disabled (login checks enabled), so there is nothing to revoke here. Revoking
    // would only log out an already-enabled admin on a redundant enable call (a no-op must not kick).
    await this.database.db
      .update(admin)
      .set({ enabled: true })
      .where(eq(admin.id, adminId));
  }

  async setRole(adminId: number, dto: AdminSetRoleDto): Promise<void> {
    const { changed } = await this.guardedStateChange(adminId, {
      kind: 'role',
      role: dto.role,
    });
    // A real role transition demotes/promotes the admin — revoke so they re-login at the new privilege
    // level. A same-role reaffirmation is a no-op (changed:false) and must NOT kick the admin.
    if (changed)
      await this.adminAuth.revokeSessionsByAdmin(adminId, 'admin_role_change');
  }

  /** SUPER_ADMIN lockout recovery: clear another admin's 2FA outright (no code — the role gate is the
   *  authority). Idempotent. resetTwoFactorBySuper throws NOT_FOUND for an unknown admin; it propagates. */
  async resetTwoFactor(adminId: number): Promise<void> {
    await this.adminAuth.resetTwoFactorBySuper(adminId);
  }

  /**
   * Race-free disable / demote. Within a transaction:
   *   1. load the target's current (role, enabled);
   *   2. if the change would remove an enabled SUPER_ADMIN from the enabled-super set, FOR UPDATE-lock
   *      the enabled super rows and refuse when only one remains;
   *   3. apply the state change in one UPDATE (atomic).
   * Throws BusinessException on NOT_FOUND (unknown admin) / FORBIDDEN (would remove the last super);
   * returns `changed` so callers revoke sessions only for a real transition. Re-enable, promote-to-super,
   * non-super disable, and same-role setRole skip the lock (no last-super risk); a no-op same-role
   * setRole (or disabling an already-disabled admin) reports changed:false so it neither revokes
   * sessions nor kicks the admin.
   */
  private async guardedStateChange(
    adminId: number,
    change: StateChange,
  ): Promise<{ changed: boolean }> {
    return this.database.db.transaction(async (tx) => {
      const current = await tx.query.admin.findFirst({
        where: eq(admin.id, adminId),
        columns: { role: true, enabled: true },
      });
      if (!current)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'admin not found');

      const demotesSuper =
        current.enabled &&
        current.role === AdminRole.SUPER_ADMIN &&
        (change.kind === 'disable' || change.role !== AdminRole.SUPER_ADMIN);

      if (demotesSuper) {
        // Lock the enabled super rows so a concurrent disable/demote serializes behind this txn, then
        // re-count under the lock (the count may have dropped if a concurrent txn already committed).
        const locked = await tx.execute<{ id: number }>(sql`
          SELECT id FROM "Admin" WHERE role = 'SUPER_ADMIN' AND enabled = true FOR UPDATE
        `);
        if (locked.rows.length <= 1) {
          throw new BusinessException(
            BusinessCode.FORBIDDEN,
            'cannot remove the last super admin',
          );
        }
      }

      // changed drives the caller's post-commit session revocation. A disable is a real change only when
      // the admin was enabled; a role change is real only when the role actually differs (a same-role
      // reaffirmation writes the same value and must not revoke anything).
      const changed =
        change.kind === 'disable'
          ? current.enabled
          : change.role !== current.role;
      const data =
        change.kind === 'disable' ? { enabled: false } : { role: change.role };

      await tx.update(admin).set(data).where(eq(admin.id, adminId));
      return { changed };
    });
  }
}
