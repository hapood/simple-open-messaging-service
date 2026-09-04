import { Public } from '../common/public.decorator.js';
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
import { MediaStorageStatsService } from './media-storage-stats.service.js';

/**
 * Read-only admin endpoints open to every admin role (no @Roles) — VIEWER included. Today: the
 * dashboard overview + the read-only media storage breakdown.
 *
 * Handlers return raw data; the global SerializeInterceptor wraps the ApiResult envelope.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@Controller()
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly mediaStorage: MediaStorageStatsService,
  ) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/dashboard')
  @ApiOperation({
    summary:
      'Console overview: online, sessions, federation health, media, recent admin actions',
  })
  async summary() {
    return this.dashboard.summary();
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/media/stats')
  @ApiOperation({
    summary: 'Read-only media storage totals from the database and CAS',
  })
  async mediaStats() {
    return this.mediaStorage.read();
  }
}
