import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { createReadStream } from 'fs';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from '../admin/admin-auth.guard.js';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import { Roles } from '../admin/admin-roles.decorator.js';
import { Audit } from '../admin/audit.decorator.js';
import { AdminRole } from '../prisma/generated/client.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { AdminListDiagnosticsDto } from './diagnostics.dto.js';
import { DiagnosticsService } from './diagnostics.service.js';
import { DiagnosticsGcService } from './diagnostics-gc.service.js';

/**
 * Admin console diagnostics endpoints: list reports (with reporter identity), stream-download a bundle,
 * and trigger GC. Read endpoints (list/download) carry no @Roles (open to every admin role incl.
 * VIEWER); the GC mutation requires ADMIN+ and is audited. Mirrors AdminController + the
 * MediaAssetGcController shape. Declared in AdminModule's controllers array (which imports
 * DiagnosticsModule for the services) — the same pattern every other admin controller uses.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Public()
@Controller()
export class AdminDiagnosticsController {
  constructor(
    private readonly diagnostics: DiagnosticsService,
    private readonly gc: DiagnosticsGcService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('admin/diagnostics')
  @ApiOperation({ summary: 'List diagnostic reports (with reporter identity)' })
  async list(@Body() dto: AdminListDiagnosticsDto): Promise<ApiResult> {
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: await this.diagnostics.list(dto),
    };
  }

  @Get('admin/diagnostics/:id/download')
  @ApiOperation({ summary: 'Download a diagnostic bundle (.tar.gz)' })
  async download(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    const reportId = Number(id);
    const abs = await this.diagnostics.resolveBundlePath(reportId);
    // Mark viewed off the critical path; a concurrent GC simply makes it a no-op.
    void this.diagnostics.markViewed(reportId);
    reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Disposition', `attachment; filename="report-${reportId}.tar.gz"`)
      .send(createReadStream(abs));
  }

  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('diagnostics.gc')
  @HttpCode(HttpStatus.OK)
  @Post('admin/diagnostics/gc')
  @ApiOperation({ summary: 'Garbage-collect expired/orphaned diagnostic bundles' })
  async triggerGc(): Promise<ApiResult> {
    const expired = await this.gc.gcExpiredReports();
    const orphan = await this.gc.gcOrphanedBundles();
    const flagged = await this.gc.reconcileDiagnostics();
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: {
        ...expired,
        orphanFiles: orphan.files,
        flaggedMissing: flagged.flagged,
      },
    };
  }

  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('diagnostics.delete')
  @HttpCode(HttpStatus.OK)
  @Post('admin/diagnostics/:id/delete')
  @ApiOperation({ summary: 'Soft-delete one diagnostic report (+ unlink its bundle if unreferenced)' })
  async delete(@Param('id') id: string): Promise<ApiResult> {
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: await this.gc.deleteReport(Number(id)),
    };
  }
}
