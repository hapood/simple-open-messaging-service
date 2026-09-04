import { Module } from '@nestjs/common';
import { PushService } from './push.service.js';
import { GatewayModule } from '../gateway/gateway.module.js';

@Module({
  imports: [GatewayModule],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
