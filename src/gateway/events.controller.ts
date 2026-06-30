import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SseService } from './sse.service';

/**
 * SSE 下行流端点：GET /api/v1/events
 *
 * 鉴权走与普通受保护路由同一套 JwtAuthGuard（verify 签名/过期 + 撤销感知），
 * 故 token 只能通过 `Authorization: Bearer <access>` 头携带（fetch-event-source 支持），
 * 不进 URL（无日志/Referer 泄漏）。失败 → guard 抛 401，前端 onopen 收到后 renew+重开。
 *
 * 手动操作 res 写 text/event-stream：NestJS 在 controller 直接操作 res 时，
 * SerializeInterceptor 的响应映射会自动跳过（官方明确），无需改动全局拦截器。
 */
@Controller('events')
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(private readonly sseService: SseService) {}

  @Get()
  stream(@Req() req: Request, @Res() res: Response): void {
    const userId = (req.user as { userId: number }).userId;
    this.sseService.register(userId, res);
  }
}
