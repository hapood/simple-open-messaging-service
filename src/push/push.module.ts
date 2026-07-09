import { Module } from '@nestjs/common';
import { PushService } from './push.service.js';
import { GatewayModule } from '../gateway/gateway.module.js';

@Module({
  // GatewayModule exports SseService — PushService queries it (isUserOnline) to skip FCM for
  // already-online recipients.
  imports: [GatewayModule],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
