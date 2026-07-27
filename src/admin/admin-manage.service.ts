import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminRole } from '../prisma/generated/client.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { AdminManageListDto, AdminCreateDto, AdminSetRoleDto } from './admin.dto.js';

type StateChange = { kind: 'disable' } | { kind: 'role'; role: AdminRole };

/** Uniform result shape so the controller is a pure HTTP adapter (no domain branching). */
type Result = { code: BusinessCode; message: string; data?: unknown };

/** guardedStateChange's internal result: the controller-facing Result plus a `changed` flag, so callers
 *  revoke sessions only on a real transition (a disable of an enabled admin, or an actual role change). */
type GuardedResult = Result & { changed: boolean };

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
 */
@Injectable()
export class AdminManageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminAuth: AdminAuthService,
  ) {}

  async list(dto: AdminManageListDto): Promise<Result> {
    const where = dto.search
      ? { user: { account: { contains: dto.search, mode: 'insensitive' as const } } }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.admin.findMany({
        where,
        skip: dto.skip ?? 0,
        take: dto.take ?? 50,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          userId: true,
          role: true,
          enabled: true,
          twoFactorEnabled: true,
          lastLoginAt: true,
          lastLoginIp: true,
          createdAt: true,
          user: { select: { account: true, name: true } },
        },
      }),
      this.prisma.admin.count({ where }),
    ]);
    // Flatten user.account/name onto the row so the response is a flat admin record.
    const list = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      account: r.user.account,
      name: r.user.name,
      role: r.role,
      enabled: r.enabled,
      twoFactorEnabled: r.twoFactorEnabled,
      lastLoginAt: r.lastLoginAt,
      lastLoginIp: r.lastLoginIp,
      createdAt: r.createdAt,
    }));
    return { code: BusinessCode.OK, message: 'success', data: { list, total } };
  }

  async create(dto: AdminCreateDto): Promise<Result> {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { isGroup: true, isDeleted: true, admins: { select: { id: true } } },
    });
    if (!user) return { code: BusinessCode.NOT_FOUND, message: 'user not found' };
    if (user.isGroup) {
      return { code: BusinessCode.VALIDATION_FAILED, message: 'a group account cannot become an admin' };
    }
    if (user.isDeleted) {
      return { code: BusinessCode.VALIDATION_FAILED, message: 'a deleted user cannot become an admin' };
    }
    if (user.admins.length > 0) {
      return { code: BusinessCode.ALREADY_EXISTS, message: 'user is already an admin' };
    }
    const admin = await this.prisma.admin.create({
      data: { userId: dto.userId, role: dto.role },
      select: { id: true, userId: true, role: true },
    });
    return { code: BusinessCode.OK, message: 'success', data: admin };
  }

  async disable(adminId: number): Promise<Result> {
    const outcome = await this.guardedStateChange(adminId, { kind: 'disable' });
    if (outcome.code !== BusinessCode.OK) return { code: outcome.code, message: outcome.message };
    // Revoke outstanding sessions only on a real disable (the admin was enabled) — deleting the linked
    // AdminSession rows is what invalidates their admin_session cookie on the next request.
    if (outcome.changed) await this.adminAuth.revokeSessionsByAdmin(adminId, 'admin_disabled');
    return { code: BusinessCode.OK, message: 'success' };
  }

  async enable(adminId: number): Promise<Result> {
    const admin = await this.prisma.admin.findUnique({ where: { id: adminId }, select: { id: true } });
    if (!admin) return { code: BusinessCode.NOT_FOUND, message: 'admin not found' };
    // No session revocation: a disabled admin's sessions were already revoked at disable time and none
    // can be created while disabled (login checks enabled), so there is nothing to revoke here. Revoking
    // would only log out an already-enabled admin on a redundant enable call (a no-op must not kick).
    await this.prisma.admin.update({ where: { id: adminId }, data: { enabled: true } });
    return { code: BusinessCode.OK, message: 'success' };
  }

  async setRole(adminId: number, dto: AdminSetRoleDto): Promise<Result> {
    const outcome = await this.guardedStateChange(adminId, { kind: 'role', role: dto.role });
    if (outcome.code !== BusinessCode.OK) return { code: outcome.code, message: outcome.message };
    // A real role transition demotes/promotes the admin — revoke so they re-login at the new privilege
    // level. A same-role reaffirmation is a no-op (changed:false) and must NOT kick the admin.
    if (outcome.changed) await this.adminAuth.revokeSessionsByAdmin(adminId, 'admin_role_change');
    return { code: BusinessCode.OK, message: 'success' };
  }

  /** SUPER_ADMIN lockout recovery: clear another admin's 2FA outright (no code — the role gate is the
   *  authority). Idempotent. Maps the service's NOT_FOUND throw to the Result envelope this controller uses. */
  async resetTwoFactor(adminId: number): Promise<Result> {
    try {
      await this.adminAuth.resetTwoFactorBySuper(adminId);
      return { code: BusinessCode.OK, message: 'success' };
    } catch (e) {
      if (e instanceof BusinessException && e.bizCode === BusinessCode.NOT_FOUND) {
        return { code: BusinessCode.NOT_FOUND, message: 'admin not found' };
      }
      throw e;
    }
  }

  /**
   * Race-free disable / demote. Within a transaction:
   *   1. load the target's current (role, enabled);
   *   2. if the change would remove an enabled SUPER_ADMIN from the enabled-super set, FOR UPDATE-lock
   *      the enabled super rows and refuse when only one remains;
   *   3. apply the state change in one UPDATE (atomic).
   * Reports `changed` so callers revoke sessions only for a real transition. Re-enable, promote-to-super,
   * non-super disable, and same-role setRole skip the lock (no last-super risk); a no-op same-role
   * setRole (or disabling an already-disabled admin) reports changed:false so it neither revokes
   * sessions nor kicks the admin.
   */
  private async guardedStateChange(adminId: number, change: StateChange): Promise<GuardedResult> {
    return this.prisma.$transaction(async (tx) => {
      const admin = await tx.admin.findUnique({
        where: { id: adminId },
        select: { role: true, enabled: true },
      });
      if (!admin) return { code: BusinessCode.NOT_FOUND, message: 'admin not found', changed: false };

      const demotesSuper =
        admin.enabled &&
        admin.role === AdminRole.SUPER_ADMIN &&
        (change.kind === 'disable' || change.role !== AdminRole.SUPER_ADMIN);

      if (demotesSuper) {
        // Lock the enabled super rows so a concurrent disable/demote serializes behind this txn, then
        // re-count under the lock (the count may have dropped if a concurrent txn already committed).
        const locked = await tx.$queryRaw<Array<{ id: number }>>`
          SELECT id FROM "Admin" WHERE role = 'SUPER_ADMIN' AND enabled = true FOR UPDATE
        `;
        if (locked.length <= 1) {
          return {
            code: BusinessCode.FORBIDDEN,
            message: 'cannot remove the last super admin',
            changed: false,
          };
        }
      }

      // changed drives the caller's post-commit session revocation. A disable is a real change only when
      // the admin was enabled; a role change is real only when the role actually differs (a same-role
      // reaffirmation writes the same value and must not revoke anything).
      const changed =
        change.kind === 'disable' ? admin.enabled : change.role !== admin.role;
      const data = change.kind === 'disable' ? { enabled: false } : { role: change.role };

      await tx.admin.update({ where: { id: adminId }, data });
      return { code: BusinessCode.OK, message: 'success', changed };
    });
  }
}
