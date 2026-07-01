import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventsController } from './events.controller.js';
import { SseService } from './sse.service.js';

@Module({
  imports: [EventEmitterModule],
  controllers: [EventsController],
  providers: [SseService],
  // SseService 供 MessageController 推送新消息、AdminController 观测在线连接。
  exports: [SseService],
})
export class GatewayModule {}
