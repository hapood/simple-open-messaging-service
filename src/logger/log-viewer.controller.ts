import { Public } from '../common/public.decorator.js';
import { Raw } from '../common/raw.decorator.js';
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
import { AdminAuthGuard } from '../admin/admin-auth.guard.js';
import { LogViewerService } from './log-viewer.service.js';
import { AdminLogHistoryDto } from './log-viewer.dto.js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/**
 * Admin log-viewer endpoints. Both are behind AdminAuthGuard (opaque admin session cookie,
 * physically isolated from user auth — same protection as every other admin endpoint). Registered in
 * AdminModule (which imports LoggerModule for LogViewerService), mirroring AdminDiagnosticsController.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@Controller('admin/logs')
@UseGuards(AdminAuthGuard)
export class LogViewerController {
  constructor(private readonly viewer: LogViewerService) {}

  /**
   * Live log tail over SSE. GET (not the admin POST convention) because this is a long-lived streaming
   * body that must behave as a true event stream across proxies/CDNs. Auth stays header-based:
   * the admin web sends its Bearer in the Authorization header, never in a URL.
   *
   * `level` filters inclusively (a selected level shows itself + every more-severe level); omitted/invalid
   * → all levels.
   */
  @Raw()
  @Sse('stream')
  @ApiOperation({ summary: 'Admin live log tail (SSE)' })
  stream(
    @Query('level') level?: string,
    @Query('scope') scope?: string,
    @Query('taskId') taskId?: string,
  ): Observable<MessageEvent> {
    return this.viewer.attach(
      this.normalizeLevel(level),
      scope || undefined,
      taskId || undefined,
    );
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

  private normalizeLevel(level?: string): string | undefined {
    if (!level) return undefined;
    const v = level.toLowerCase();
    return (LEVELS as readonly string[]).includes(v) ? v : undefined;
  }
}
