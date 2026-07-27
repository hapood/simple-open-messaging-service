import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Raw } from '../common/raw.decorator.js';
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
 * Manually writes text/event-stream to the raw response: first reply.hijack() takes over the raw response (must be called before any reply.raw
 * write, otherwise headers-already-sent is triggered), then hands reply.raw to SseService.
 * When a controller manipulates reply directly, NestJS automatically skips SerializeInterceptor's response mapping
 * (officially documented), so no change to the global interceptor is needed.
 */
@Raw()
@Controller('events')
export class EventsController {
  constructor(private readonly sseService: SseService) {}

  @Get()
  stream(@Req() req: FastifyRequest, @Res() reply: FastifyReply): void {
    reply.hijack(); // take over the raw response for the infinite SSE stream
    const user = req.user as { userId: number; sessionId: number };
    // Forward the request Origin: hijack bypasses @fastify/cors, so the reflected CORS header must be
    // written on the raw stream or cross-origin clients (Tauri desktop/Android) can never read it.
    // sessionId lets SseService target this exact session for FORCE_LOGOUT on a device-revoke.
    this.sseService.register(user.userId, user.sessionId, reply.raw, req.headers.origin);
  }
}
