import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminAuditQueryDto } from './admin.dto.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { PrismaService } from '../prisma.service.js';

/**
 * Read-only viewer for the AdminActionLog trail (written by AdminAuditInterceptor). Open to every
 * admin role (incl. VIEWER) — auditing who did what is itself a core observability need. Mirrors the
 * other admin controllers: @Controller() + full admin/ path, AdminAuthGuard, ApiResult envelope.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@Controller()
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/audit')
  @ApiOperation({ summary: 'Admin action audit log (paginated + filter by action/adminId/success)' })
  async list(@Body() dto: AdminAuditQueryDto): Promise<ApiResult> {
    const where = {
      ...(dto.action ? { action: { contains: dto.action } } : {}),
      ...(dto.adminId ? { adminId: dto.adminId } : {}),
      ...(dto.success === true || dto.success === false ? { success: dto.success } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.adminActionLog.findMany({
        where,
        skip: dto.skip ?? 0,
        take: dto.take ?? 50,
        orderBy: { at: 'desc' },
        select: {
          id: true,
          adminId: true,
          adminRole: true,
          action: true,
          targetType: true,
          targetId: true,
          ip: true,
          userAgent: true,
          route: true,
          success: true,
          errorMessage: true,
          at: true,
        },
      }),
      this.prisma.adminActionLog.count({ where }),
    ]);
    // Resolve each row's targetId into a human-friendly account name so the target column reads
    // "user: alice" instead of "user: 7". Best-effort + bucketed (see attachTargetLabels).
    const labelByKey = await this.attachTargetLabels(rows);
    const list = rows.map((r) => ({
      ...r,
      targetLabel:
        r.targetType && r.targetId ? (labelByKey.get(`${r.targetType}:${r.targetId}`) ?? null) : null,
    }));
    return { code: BusinessCode.OK, message: 'success', data: { list, total } };
  }

  /**
   * Resolve audit target ids into account-name labels, bucketed by targetType with ONE findMany per
   * type (an IN-list) so a 50-row page costs at most ~7 bounded queries, never N+1. Targets that are
   * already readable (peer / quota-node = domain) or absent are skipped — the client then falls back
   * to the raw targetId. Soft-deleted rows ARE resolved: the referenced user/admin keeps its
   * (immutable) account name forever, which is exactly what an auditor needs, so there is deliberately
   * NO isDeleted filter. admin_session / webauthn_credential ids are BigInt; the rest are Int — each
   * lands in the right IN-list. A non-numeric targetId (or an unknown type) is ignored, never thrown.
   */
  private async attachTargetLabels(
    rows: Array<{ targetType: string | null; targetId: string | null }>,
  ): Promise<Map<string, string>> {
    const labelByKey = new Map<string, string>();
    const put = (type: string, id: string | number | bigint, label: string): void => {
      labelByKey.set(`${type}:${id}`, label);
    };

    const bigBuckets = {
      admin_session: new Set<bigint>(),
      webauthn_credential: new Set<bigint>(),
    };
    const intBuckets = {
      user: new Set<number>(),
      admin: new Set<number>(),
      user_session: new Set<number>(),
      login_code: new Set<number>(),
      push_token: new Set<number>(),
    };
    for (const r of rows) {
      const t = r.targetType;
      const id = r.targetId;
      if (!t || !id || !/^\d+$/.test(id)) continue;
      if (t in bigBuckets) bigBuckets[t as keyof typeof bigBuckets].add(BigInt(id));
      else if (t in intBuckets) intBuckets[t as keyof typeof intBuckets].add(Number(id));
    }

    const [users, admins, sessions, adminSessions, loginCodes, pushTokens, webauthns] =
      await Promise.all([
        intBuckets.user.size
          ? this.prisma.user.findMany({
              where: { id: { in: [...intBuckets.user] } },
              select: { id: true, account: true },
            })
          : [],
        intBuckets.admin.size
          ? this.prisma.admin.findMany({
              where: { id: { in: [...intBuckets.admin] } },
              select: { id: true, user: { select: { account: true } } },
            })
          : [],
        intBuckets.user_session.size
          ? this.prisma.sessionToken.findMany({
              where: { id: { in: [...intBuckets.user_session] } },
              select: { id: true, user: { select: { account: true } } },
            })
          : [],
        bigBuckets.admin_session.size
          ? this.prisma.adminSession.findMany({
              where: { id: { in: [...bigBuckets.admin_session] } },
              select: { id: true, admin: { select: { user: { select: { account: true } } } } },
            })
          : [],
        intBuckets.login_code.size
          ? this.prisma.loginCode.findMany({
              where: { id: { in: [...intBuckets.login_code] } },
              select: { id: true, user: { select: { account: true } } },
            })
          : [],
        intBuckets.push_token.size
          ? this.prisma.pushToken.findMany({
              where: { id: { in: [...intBuckets.push_token] } },
              select: { id: true, user: { select: { account: true } } },
            })
          : [],
        bigBuckets.webauthn_credential.size
          ? this.prisma.webAuthnCredential.findMany({
              where: { id: { in: [...bigBuckets.webauthn_credential] } },
              select: { id: true, admin: { select: { user: { select: { account: true } } } } },
            })
          : [],
      ]);

    for (const u of users) put('user', u.id, u.account);
    for (const a of admins) put('admin', a.id, a.user.account);
    for (const s of sessions) put('user_session', s.id, s.user.account);
    for (const a of adminSessions) put('admin_session', a.id, a.admin.user.account);
    for (const c of loginCodes) put('login_code', c.id, c.user.account);
    for (const p of pushTokens) put('push_token', p.id, p.user.account);
    for (const w of webauthns) put('webauthn_credential', w.id, w.admin.user.account);

    return labelByKey;
  }
}
