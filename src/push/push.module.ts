import { Module } from '@nestjs/common';
import { PushService } from './push.service.js';
import { RequestAttentionService } from '../relationship/request/request-attention.service.js';
import { GatewayModule } from '../gateway/gateway.module.js';

@Module({
  imports: [GatewayModule],
  providers: [PushService, RequestAttentionService],
  exports: [PushService],
})
export class PushModule {}
