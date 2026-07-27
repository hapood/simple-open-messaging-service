import { Public } from '../common/public.decorator.js';
import { Raw } from '../common/raw.decorator.js';
import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
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
   * body that must behave as a true event stream across proxies/CDNs. Auth stays header-based: the
   * admin web opens it with fetch + ReadableStream (a port of the C-end sse.worker) so the admin
   * Bearer rides in the Authorization header — there is NO `?token=` fallback, because a token in the
   * URL would land in our own access logs (the worst place to leak a credential).
   *
   * `level` filters inclusively (a selected level shows itself + every more-severe level); omitted/invalid
   * → all levels.
   */
  @Raw()
  @Get('stream')
  @ApiOperation({ summary: 'Admin live log tail (SSE)' })
  stream(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('level') level?: string,
  ): void {
    reply.hijack(); // take over the raw response before any reply.raw write
    // Forward the request Origin: hijack bypasses @fastify/cors, so the reflected CORS header must be
    // written on the raw stream or cross-origin admin-web (:5180) can never read the log tail.
    this.viewer.attach(reply.raw, this.normalizeLevel(level), req.headers.origin);
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
