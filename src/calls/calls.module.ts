import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CallsService } from './calls.service.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { PushModule } from '../push/push.module.js';
import { ThreadParticipantModule } from '../thread-participant/thread-participant.module.js';
import { MessageModule } from '../message/message.module.js';

@Module({
  // GatewayModule → SseService, PushModule → PushService, ThreadParticipantModule →
  // ThreadParticipantService, MessageModule → MessageService (terminal bubble write).
  // EventEmitterModule is NOT global (only forRoot() lives in AppModule) — imported here so the
  // @OnEvent('call.frame.inbound') handler on CallsService is discovered (the inbound S2S bridge).
  // MessageFanoutService + FederationService + QuotaService + PrismaService are all @Global — no
  // import needed. CallsService is exported so CallsController — registered in AppModule per the
  // codebase convention (controllers live in AppModule.controllers[], not their feature module) —
  // can inject it.
  imports: [EventEmitterModule, GatewayModule, PushModule, ThreadParticipantModule, MessageModule],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
