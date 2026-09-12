import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventsController } from './events.controller.js';
import { SseService } from './sse.service.js';
import { CallStateRegistry } from './call-state.registry.js';

@Module({
  imports: [EventEmitterModule],
  controllers: [EventsController],
  // CallStateRegistry: the active-call mirror CallsService writes + SseService reads for the HELLO (breaks the
  // Sse↔Calls DI cycle — see call-state.registry.ts).
  providers: [SseService, CallStateRegistry],
  // SseService is consumed by MessageController to push new messages and by AdminController to observe online connections.
  // CallStateRegistry is exported so CallsModule (which imports GatewayModule) can inject it.
  exports: [SseService, CallStateRegistry],
})
export class GatewayModule {}
