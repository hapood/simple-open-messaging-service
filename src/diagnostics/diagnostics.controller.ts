import {
  Controller,
  Post,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DiagnosticsService } from './diagnostics.service.js';

/** The authenticated principal the global SessionAuthGuard stamps on the request (cookie or Bearer). */
interface AuthedUser {
  userId: number;
  sessionId: number;
  mustChangePassword: boolean;
}

/**
 * Consumer-facing diagnostics endpoint. A client (Tauri desktop/Android) POSTs a diagnostic bundle —
 * multipart: `bundle` = the gzip tar of its Rust logs + webview console capture, `manifest` = a JSON
 * version/platform snapshot — for field support. The reporter is pinned to the authenticated user, and
 * there is NO consumer list endpoint, so one user can never see another's reports. Rate-limited per
 * user (in-service window in DiagnosticsService) + per IP (@Throttle). Admins read/list/download via
 * AdminDiagnosticsController.
 */
@ApiTags('diagnostics')
@ApiBearerAuth()
@Controller()
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @UseGuards(ThrottleGuard)
  @Throttle(5, 60) // per-IP burst ceiling; the per-user window lives in the service
  @HttpCode(HttpStatus.OK)
  @Post('diagnostics/report')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a diagnostic log bundle for field support' })
  async report(@Request() req: FastifyRequest) {
    // SessionAuthGuard (the global APP_GUARD) already guarantees req.user for a non-@Public route and
    // rejects unauthenticated calls before this handler; the cast + check is defense-in-depth + TS.
    const user = (req as unknown as { user?: AuthedUser }).user;
    const userId = user?.userId;
    if (typeof userId !== 'number') {
      // Defense-in-depth only (the guard already rejected unauthenticated calls). Thrown as HTTP 200 +
      // UNAUTHENTICATED to match the prior wire; the global AllExceptionsFilter renders the body.
      throw new BusinessException(BusinessCode.UNAUTHENTICATED, 'unauthenticated');
    }
    const { buffer, manifest } = await this.diagnostics.consumeBundle(req);
    const { id } = await this.diagnostics.storeReport(userId, buffer, manifest);
    return { id };
  }
}
