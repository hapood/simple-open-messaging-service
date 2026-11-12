import { Public } from '../common/public.decorator.js';
import { Raw } from '../common/raw.decorator.js';
import { withSseHeartbeat } from '../common/sse-heartbeat.js';
import {
  Body,
  Controller,
  Sse,
  Post,
  Query,
  type MessageEvent,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import { Roles } from '../admin/admin-roles.decorator.js';
import { Audit } from '../admin/audit.decorator.js';
import { AdminRole } from '../database/enums.js';
import { AdminAuthGuard } from '../admin/admin-auth.guard.js';
import { LogViewerService } from './log-viewer.service.js';
import { LogLevelService } from './log-level.service.js';
import {
  AdminLogHistoryDto,
  AdminLogOutputLevelDto,
} from './log-viewer.dto.js';

/**
 * Admin log-viewer endpoints. All are behind AdminAuthGuard (opaque admin session cookie,
 * physically isolated from user auth — same protection as every other admin endpoint). Registered in
 * AdminModule (which imports LoggerModule for LogViewerService), mirroring AdminDiagnosticsController.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@Controller('admin/logs')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class LogViewerController {
  constructor(
    private readonly viewer: LogViewerService,
    private readonly output: LogLevelService,
  ) {}

  @Post('output-level')
  @ApiOperation({ summary: 'Read the process-local log output level' })
  outputLevel() {
    return this.output.getLevel();
  }

  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('logs.output_level.set')
  @Post('output-level/set')
  @ApiOperation({
    summary: 'Change log output level until the process restarts',
  })
  setOutputLevel(@Body() dto: AdminLogOutputLevelDto) {
    return this.output.setLevel(dto.level);
  }

  /**
   * Live log tail over SSE. GET (not the admin POST convention) because this is a long-lived streaming
   * body that must behave as a true event stream across proxies/CDNs. Authentication uses the
   * same-origin admin session cookie.
   *
   * Streams every captured record; the process-local output threshold controls new log production.
   */
  @Raw()
  @Sse('stream')
  @ApiOperation({ summary: 'Admin live log tail (SSE)' })
  stream(
    @Query('scope') scope?: string,
    @Query('taskId') taskId?: string,
  ): Observable<MessageEvent> {
    return this.viewer
      .attach(scope || undefined, taskId || undefined)
      .pipe(withSseHeartbeat());
  }

  /**
   * Historical log search across the current file + rotated archives. POST (admin convention) with an
   * offset-paginated {skip, take, level?, from?, to?, search?} body → {list, total, truncated}.
   * `truncated` means the LOG_HISTORY_SCAN_BYTES cap was hit (older matches exist beyond the window).
   */
  @Post('history')
  @ApiOperation({ summary: 'Admin historical log search' })
  history(@Body() dto: AdminLogHistoryDto) {
    return this.viewer.history(dto);
  }
}
