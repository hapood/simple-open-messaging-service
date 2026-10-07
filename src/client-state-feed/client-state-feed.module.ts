import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module.js';
import { ClientStateFeedService } from './client-state-feed.service.js';
import { ClientGroupMetaFeedService } from './client-group-meta-feed.service.js';

/** Device-facing compacted state-feed services. Consumers import this module explicitly. */
@Module({
  imports: [GatewayModule], // SseService
  providers: [ClientStateFeedService, ClientGroupMetaFeedService],
  exports: [ClientStateFeedService, ClientGroupMetaFeedService],
})
export class ClientStateFeedModule {}
