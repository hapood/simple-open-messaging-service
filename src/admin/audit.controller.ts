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
    const [list, total] = await Promise.all([
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
    return { code: BusinessCode.OK, message: 'success', data: { list, total } };
  }
}
