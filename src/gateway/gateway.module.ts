import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MessageModule } from '../message/message.module.js';
import { EventsController } from './events.controller.js';
import { SseService } from './sse.service.js';

@Module({
  // MessageModule → MessageService, for the HELLO connect handshake (the user's newest-message cursor).
  imports: [EventEmitterModule, MessageModule],
  controllers: [EventsController],
  providers: [SseService],
  // SseService is consumed by MessageController to push new messages and by AdminController to observe online connections.
  exports: [SseService],
})
export class GatewayModule {}
