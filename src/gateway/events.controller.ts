import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { Raw } from '../common/raw.decorator.js';
import { EventsReceiptDto } from './events-receipt.dto.js';
import { SseService } from './sse.service.js';

/**
 * SSE downlink stream endpoint: GET /api/v1/events
 *
 * Authentication goes through the same SessionAuthGuard as ordinary protected routes (cookie-first,
 * Bearer fallback — see session-auth.guard.ts). The browser auto-attaches the httpOnly session cookie
 * same-origin; native clients + the desktop SSE worker (cross-origin, can't use a cookie) send
 * `Authorization: Bearer`. The token is never carried in the URL (no log/Referer leakage). On failure
 * → the guard throws 401, and the frontend re-opens on reconnect.
 *
 * Nest owns the stream, sends SSE headers, and unsubscribes the event source on disconnect.
 * The raw marker prevents the API response interceptor from wrapping events in envelopes.
 */
@Controller('events')
export class EventsController {
  constructor(private readonly sseService: SseService) {}

  @Raw()
  @Sse()
  stream(@Req() req: FastifyRequest): Observable<MessageEvent> {
    const user = req.user as { userId: number; sessionId: number };
    return this.sseService.register(user.userId, user.sessionId);
  }

  @Post('receipt')
  @HttpCode(HttpStatus.OK)
  async receipt(@Req() req: FastifyRequest, @Body() dto: EventsReceiptDto) {
    const user = req.user as { userId: number; sessionId: number };
    return {
      accepted: await this.sseService.confirmThreadReceipt(
        user.userId,
        user.sessionId,
        dto.sseUuid,
        dto.threadFeedEndId,
      ),
    };
  }
}
