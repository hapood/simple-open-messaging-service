import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminAuditQueryDto, AdminAuditDetailDto } from './admin.dto.js';
import { AUDIT_ACTIONS } from './audit-actions.js';
import { and, count, desc, eq, like, gte, lt } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { adminActionLog } from '../database/schema.js';
import { AuditTargetLabelService } from './audit-target-label.service.js';

/**
 * Read-only viewer for the AdminActionLog trail (written by AdminAuditInterceptor). Open to every
 * admin role (incl. VIEWER) — auditing who did what is itself a core observability need. Mirrors the
 * other admin controllers: @Controller() + full admin/ path, AdminAuthGuard, ApiResult envelope.
 *
 * Target-label resolution (targetId → account name) is delegated to AuditTargetLabelService, shared
 * with DashboardService so the dashboard's recent-actions strip shows the same friendly labels.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@Controller()
export class AuditController {
  constructor(
    private readonly database: DatabaseService,
    private readonly labels: AuditTargetLabelService,
  ) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/audit')
  @ApiOperation({
    summary:
      'Admin action audit log (paginated + filter by action/adminId/status)',
  })
  async list(@Body() dto: AdminAuditQueryDto) {
    const from = dto.from ? new Date(dto.from) : undefined;
    const to = dto.to ? new Date(dto.to) : undefined;
    if (
      (from && Number.isNaN(from.getTime())) ||
      (to && Number.isNaN(to.getTime()))
    ) {
      throw new BadRequestException('Invalid time bound');
    }
    if (from && to && from >= to) {
      throw new BadRequestException('Start time must precede end time');
    }
    const where = and(
      from ? gte(adminActionLog.createdAt, from) : undefined,
      to ? lt(adminActionLog.createdAt, to) : undefined,
      dto.action
        ? like(
            adminActionLog.action,
            `%${dto.action.replace(/[\\%_]/g, '\\$&')}%`,
          )
        : undefined,
      dto.adminId ? eq(adminActionLog.adminId, dto.adminId) : undefined,
      dto.status ? eq(adminActionLog.status, dto.status) : undefined,
    );
    const [rows, total] = await Promise.all([
      this.database.db
        .select({
          id: adminActionLog.id,
          adminId: adminActionLog.adminId,
          adminRole: adminActionLog.adminRole,
          action: adminActionLog.action,
          targetType: adminActionLog.targetType,
          targetId: adminActionLog.targetId,
          ip: adminActionLog.ip,
          userAgent: adminActionLog.userAgent,
          route: adminActionLog.route,
          status: adminActionLog.status,
          errorMessage: adminActionLog.errorMessage,
          createdAt: adminActionLog.createdAt,
        })
        .from(adminActionLog)
        .where(where)
        .orderBy(desc(adminActionLog.createdAt), desc(adminActionLog.id))
        .offset(dto.skip ?? 0)
        .limit(dto.take ?? 50),
      this.database.db
        .select({ value: count() })
        .from(adminActionLog)
        .where(where)
        .then(([row]) => row.value),
    ]);
    // Resolve each row's targetId into a human-friendly account name so the target column reads
    // "user: alice" instead of "user: 7". Shared with the dashboard (AuditTargetLabelService).
    const labelByKey = await this.labels.resolve(rows);
    const list = rows.map((r) => ({
      ...r,
      targetLabel:
        r.targetType && r.targetId
          ? (labelByKey.get(`${r.targetType}:${r.targetId}`) ?? null)
          : null,
    }));
    return { list, total };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/audit/actions')
  @ApiOperation({ summary: 'Registered admin audit actions' })
  actions() {
    return { actions: Object.keys(AUDIT_ACTIONS) };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/audit/detail')
  @ApiOperation({
    summary: 'Admin audit record including allowlisted operation data',
  })
  async detail(@Body() dto: AdminAuditDetailDto) {
    const id = BigInt(dto.id);
    if (id > 9223372036854775807n)
      throw new BadRequestException('Invalid audit ID');
    const [row] = await this.database.db
      .select()
      .from(adminActionLog)
      .where(eq(adminActionLog.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Audit record not found');
    const labels = await this.labels.resolve([row]);
    return {
      ...row,
      targetLabel:
        row.targetType && row.targetId
          ? (labels.get(`${row.targetType}:${row.targetId}`) ?? null)
          : null,
    };
  }
}
