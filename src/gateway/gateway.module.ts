import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventsController } from './events.controller.js';
import { SseService } from './sse.service.js';

@Module({
  imports: [EventEmitterModule],
  controllers: [EventsController],
  providers: [SseService],
  // SseService is consumed by MessageController to push new messages and by AdminController to observe online connections.
  exports: [SseService],
})
export class GatewayModule {}
