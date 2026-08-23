import { Module, Global } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module.js';
import { ClientStateFeedService } from './client-state-feed.service.js';
import { ClientGroupMetaFeedService } from './client-group-meta-feed.service.js';

/** Global device-facing compacted state-feed services. */
@Global()
@Module({
  imports: [GatewayModule], // SseService
  providers: [ClientStateFeedService, ClientGroupMetaFeedService],
  exports: [ClientStateFeedService, ClientGroupMetaFeedService],
})
export class ClientStateFeedModule {}
