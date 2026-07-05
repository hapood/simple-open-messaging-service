import { Module } from '@nestjs/common';
import { PushService } from './push.service.js';
import { PrismaService } from '../prisma.service.js';
import { GatewayModule } from '../gateway/gateway.module.js';

@Module({
  // GatewayModule exports SseService — PushService queries it (isUserOnline) to skip FCM for
  // already-online recipients. PrismaService is re-declared here per the project's per-module convention.
  imports: [GatewayModule],
  providers: [PushService, PrismaService],
  exports: [PushService],
})
export class PushModule {}
