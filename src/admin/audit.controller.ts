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
import { PrismaService } from '../prisma.service.js';
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
    private readonly prisma: PrismaService,
    private readonly labels: AuditTargetLabelService,
  ) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/audit')
  @ApiOperation({ summary: 'Admin action audit log (paginated + filter by action/adminId/success)' })
  async list(@Body() dto: AdminAuditQueryDto) {
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
    // "user: alice" instead of "user: 7". Shared with the dashboard (AuditTargetLabelService).
    const labelByKey = await this.labels.resolve(rows);
    const list = rows.map((r) => ({
      ...r,
      targetLabel:
        r.targetType && r.targetId ? (labelByKey.get(`${r.targetType}:${r.targetId}`) ?? null) : null,
    }));
    return { list, total };
  }
}
