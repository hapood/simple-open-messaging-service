import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminRole } from '../prisma/generated/client.js';
import { BusinessCode } from '../common/business-code.js';
import type { AdminManageListDto, AdminCreateDto, AdminSetRoleDto } from './admin.dto.js';

type StateChange = { kind: 'disable' } | { kind: 'role'; role: AdminRole };

/** Uniform result shape so the controller is a pure HTTP adapter (no domain branching). */
type Result = { code: BusinessCode; message: string; data?: unknown };

/**
 * Admin self-management domain logic: list, promote, disable/enable, role change.
 *
 * The last-super guard is RACE-FREE. disable / demote of an enabled SUPER_ADMIN runs inside a
 * $transaction that SELECT ... FOR UPDATE-locks every enabled super row before counting, so two
 * super-admins disabling each other concurrently cannot drive the enabled-super count to 0: the
 * second transaction blocks on the row lock, then re-reads the post-commit count and refuses. The
 * tokenVersion bump is folded into the SAME guarded UPDATE, so a disabled/demoted admin's access
 * token dies the instant the transaction commits — refresh-token revocation (revokeRefreshByAdmin)
 * runs afterwards, best-effort.
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
    if (outcome.code !== BusinessCode.OK) return outcome;
    // The access token is already dead via the in-tx tokenVersion bump; refresh revocation is best-effort.
    await this.adminAuth.revokeRefreshByAdmin(adminId, 'admin_disabled').catch(() => {
      /* best-effort: access token already invalidated by the tokenVersion bump */
    });
    return outcome;
  }

  async enable(adminId: number): Promise<Result> {
    const admin = await this.prisma.admin.findUnique({ where: { id: adminId }, select: { id: true } });
    if (!admin) return { code: BusinessCode.NOT_FOUND, message: 'admin not found' };
    await this.prisma.admin.update({ where: { id: adminId }, data: { enabled: true } });
    return { code: BusinessCode.OK, message: 'success' };
  }

  async setRole(adminId: number, dto: AdminSetRoleDto): Promise<Result> {
    const outcome = await this.guardedStateChange(adminId, { kind: 'role', role: dto.role });
    if (outcome.code !== BusinessCode.OK) return outcome;
    await this.adminAuth.revokeRefreshByAdmin(adminId, 'admin_role_change').catch(() => {
      /* best-effort */
    });
    return outcome;
  }

  /**
   * Race-free disable / demote. Within a transaction:
   *   1. load the target's current (role, enabled);
   *   2. if the change would remove an enabled SUPER_ADMIN from the enabled-super set, FOR UPDATE-lock
   *      the enabled super rows and refuse when only one remains;
   *   3. apply the state change + tokenVersion bump in one UPDATE (atomic).
   * Re-enable, promote-to-super, non-super disable, and same-role setRole skip the lock (no last-super
   * risk); a no-op same-role setRole also skips the tokenVersion bump so it doesn't kick the admin.
   */
  private async guardedStateChange(adminId: number, change: StateChange): Promise<Result> {
    return this.prisma.$transaction(async (tx) => {
      const admin = await tx.admin.findUnique({
        where: { id: adminId },
        select: { role: true, enabled: true },
      });
      if (!admin) return { code: BusinessCode.NOT_FOUND, message: 'admin not found' };

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
          return { code: BusinessCode.FORBIDDEN, message: 'cannot remove the last super admin' };
        }
      }

      const data =
        change.kind === 'disable'
          ? { enabled: false, tokenVersion: { increment: 1 } }
          : change.role === admin.role
            ? { role: change.role } // no-op role reaffirmation: no tver bump, no session kick
            : { role: change.role, tokenVersion: { increment: 1 } };

      await tx.admin.update({ where: { id: adminId }, data });
      return { code: BusinessCode.OK, message: 'success' };
    });
  }
}
