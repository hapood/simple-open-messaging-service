import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SseService } from './sse.service.js';

/**
 * SSE downlink stream endpoint: GET /api/v1/events
 *
 * Authentication goes through the same JwtAuthGuard as ordinary protected routes (verifies signature/expiry + revocation-aware),
 * so the token can only be carried via the `Authorization: Bearer <access>` header (supported by fetch-event-source)
 * and never in the URL (no log/Referer leakage). On failure → the guard throws 401, and the frontend renews and reopens on open.
 *
 * Manually writes text/event-stream to the raw response: first reply.hijack() takes over the raw response (must be called before any reply.raw
 * write, otherwise headers-already-sent is triggered), then hands reply.raw to SseService.
 * When a controller manipulates reply directly, NestJS automatically skips SerializeInterceptor's response mapping
 * (officially documented), so no change to the global interceptor is needed.
 */
@Controller('events')
export class EventsController {
  constructor(private readonly sseService: SseService) {}

  @Get()
  stream(@Req() req: FastifyRequest, @Res() reply: FastifyReply): void {
    reply.hijack(); // take over the raw response for the infinite SSE stream
    const userId = (req.user as { userId: number }).userId;
    this.sseService.register(userId, reply.raw);
  }
}
