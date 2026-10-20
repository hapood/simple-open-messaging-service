import { Module } from '@nestjs/common';
import { AccountThreadStateModule } from '../account-thread-state/account-thread-state.module.js';
import { MessageModule } from '../message/message.module.js';
import { ClientStateFeedModule } from '../client-state-feed/client-state-feed.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { RelationshipIntentService } from './relationship-intent.service.js';
import { RelationshipService } from './relationship.service.js';
import { RequestTransactionCapability } from './request/request-transaction.contract.js';
import { RequestTransactionCapabilityImpl } from './request/request-transaction-capability.impl.js';
import { RelationshipRequestService } from './request/relationship-request.service.js';
import { RelationshipRequestServiceImpl } from './request/relationship-request.service.impl.js';

/**
 * Relationship domain module. Pair + Intent own relationship state and transitions. Local conversation
 * state is handled through AccountThreadStateService; source-scoped projections remain independent.
 * The P2P write path (authored and received) runs synchronously through the
 * user intent family exported by FederationModule; this module keeps the
 * remaining relationship projections and query-denial cleanup.
 */
@Module({
  imports: [
    AccountThreadStateModule,
    MessageModule,
    ClientStateFeedModule,
    GatewayModule,
  ],
  providers: [
    RelationshipService,
    RelationshipIntentService,
    {
      provide: RequestTransactionCapability,
      useClass: RequestTransactionCapabilityImpl,
    },
    {
      provide: RelationshipRequestService,
      useClass: RelationshipRequestServiceImpl,
    },
  ],
  exports: [
    RelationshipService,
    RelationshipIntentService,
    RequestTransactionCapability,
    RelationshipRequestService,
  ],
})
export class RelationshipModule {}
