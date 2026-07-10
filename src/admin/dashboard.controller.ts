import {
  Controller,
  Post,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { DashboardService } from './dashboard.service.js';
import { MediaAssetGcService } from './media-asset-gc.service.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * Read-only admin endpoints open to every admin role (no @Roles) — VIEWER included. Today: the
 * dashboard overview + the media storage breakdown (the GC triggers themselves live in
 * MediaAssetGcController and are SUPER_ADMIN-only; the *view* of storage is read-only).
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller()
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly gc: MediaAssetGcService,
  ) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/dashboard')
  @ApiOperation({
    summary: 'Console overview: online, sessions, federation health, media, recent admin actions',
  })
  async summary(): Promise<ApiResult> {
    return { code: BusinessCode.OK, message: 'success', data: await this.dashboard.summary() };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/stats')
  @ApiOperation({
    summary: 'Media storage overview: DB bytes/count/reclaimable + on-disk per-extension breakdown',
  })
  async mediaStats(): Promise<ApiResult> {
    return { code: BusinessCode.OK, message: 'success', data: await this.gc.stats() };
  }
}
