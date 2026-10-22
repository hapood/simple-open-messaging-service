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
import { and, count, desc, eq, like } from 'drizzle-orm';
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
    const where = and(
      dto.action ? like(adminActionLog.action, `%${dto.action}%`) : undefined,
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
          at: adminActionLog.at,
        })
        .from(adminActionLog)
        .where(where)
        .orderBy(desc(adminActionLog.at))
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
}
