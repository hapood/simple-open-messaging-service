import { accountProfileFields } from '../user/account-profile.js';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  admin,
  adminSession,
  adminLoginChallenge,
  loginCode,
  account as user,
} from '../database/schema.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminRole } from '../database/enums.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { AdminManageListDto, AdminSetRoleDto } from './admin.dto.js';

import { SessionTokenService } from '../auth/session-token.service.js';
import { EventEmitter2 } from '@nestjs/event-emitter';

type StateChange =
  | { kind: 'disable' }
  | { kind: 'enable' }
  | { kind: 'role'; role: AdminRole };

/**
 * Admin self-management domain logic: list, promote, disable/enable, role change.
 *
 * Mutations lock Account → Admin before reading roles. Super-admin grants are immutable.
 * Role changes and disables revoke sessions in the same transaction; no-op changes do not.
 * Generic user management cannot disable administrator accounts.
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
    private readonly sessions: SessionTokenService,
    private readonly events: EventEmitter2,
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
          name: accountProfileFields(user).name,
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

  /** Grant only read-only access. Role escalation is a separate super-admin operation. */
  async grantViewer(userId: number) {
    const result = await this.database.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(user)
        .where(eq(user.id, userId))
        .for('no key update');
      if (!candidate || candidate.namespaceId !== 0)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'local user not found',
        );
      if (
        candidate.availability === 'REMOVED' ||
        candidate.disabledAt !== null ||
        candidate.mustChangePassword
      )
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'account must be active and finish password setup before receiving admin access',
        );
      const existing = await tx.query.admin.findFirst({
        where: eq(admin.userId, userId),
      });
      if (existing)
        throw new BusinessException(
          BusinessCode.ALREADY_EXISTS,
          'user already has admin access',
        );
      await tx
        .update(loginCode)
        .set({ revokedAt: new Date() })
        .where(and(eq(loginCode.userId, userId), isNull(loginCode.revokedAt)));
      const [row] = await tx
        .insert(admin)
        .values({ userId, role: AdminRole.VIEWER, updatedAt: new Date() })
        .returning({ id: admin.id, userId: admin.userId, role: admin.role });
      const hashes = await this.sessions.revokeAllInTransaction(
        tx,
        userId,
        'admin_access_granted',
      );
      return { row, hashes };
    });
    await this.sessions.clearRevokedCache(result.hashes);
    this.events.emit('auth.sessions-invalidated', {
      userId,
      reason: 'admin_access_granted',
    });
    return result.row;
  }

  async disable(adminId: number): Promise<void> {
    await this.guardedStateChange(adminId, { kind: 'disable' });
  }

  async enable(adminId: number): Promise<void> {
    await this.guardedStateChange(adminId, { kind: 'enable' });
  }

  async setRole(adminId: number, dto: AdminSetRoleDto): Promise<void> {
    if (dto.role !== AdminRole.ADMIN && dto.role !== AdminRole.VIEWER)
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'super-admin access cannot be granted',
      );
    await this.guardedStateChange(adminId, { kind: 'role', role: dto.role });
  }

  /** SUPER_ADMIN lockout recovery: clear another admin's 2FA outright (no code — the role gate is the
   *  authority). Idempotent. resetTwoFactorBySuper throws NOT_FOUND for an unknown admin; it propagates. */
  async resetTwoFactor(adminId: number): Promise<void> {
    await this.adminAuth.resetTwoFactorBySuper(adminId);
  }

  /** Lock before reading authorization state, protect super grants, and revoke atomically. */
  private async guardedStateChange(
    adminId: number,
    change: StateChange,
  ): Promise<{ changed: boolean }> {
    return this.database.db.transaction(async (tx) => {
      const owner = await tx.query.admin.findFirst({
        where: eq(admin.id, adminId),
      });
      if (!owner)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'admin not found');
      const [account] = await tx
        .select()
        .from(user)
        .where(eq(user.id, owner.userId))
        .for('no key update');
      const [current] = await tx
        .select()
        .from(admin)
        .where(eq(admin.id, adminId))
        .for('no key update');
      if (!current)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'admin not found');

      if (current.role === AdminRole.SUPER_ADMIN)
        throw new BusinessException(
          BusinessCode.FORBIDDEN,
          'super-admin access cannot be modified',
        );

      if (
        change.kind !== 'disable' &&
        (!account ||
          account.disabledAt !== null ||
          account.availability === 'REMOVED')
      )
        throw new BusinessException(
          BusinessCode.FORBIDDEN,
          'account is unavailable',
        );
      const changed =
        change.kind === 'role'
          ? change.role !== current.role
          : current.enabled !== (change.kind === 'enable');
      if (!changed) return { changed: false };
      const data =
        change.kind === 'role'
          ? { role: change.role }
          : { enabled: change.kind === 'enable' };
      await tx
        .update(admin)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(admin.id, adminId));
      if (change.kind !== 'enable') {
        await tx
          .update(adminSession)
          .set({
            revokedAt: new Date(),
            revokeReason:
              change.kind === 'disable'
                ? 'admin_disabled'
                : 'admin_role_change',
          })
          .where(
            and(
              eq(adminSession.adminId, adminId),
              isNull(adminSession.revokedAt),
            ),
          );
        await tx
          .delete(adminLoginChallenge)
          .where(eq(adminLoginChallenge.adminId, adminId));
      }
      return { changed };
    });
  }
}
