import { Module } from '@nestjs/common';
import { AccountThreadStateModule } from '../../account-thread-state/account-thread-state.module.js';
import { MessageModule } from '../../message/message.module.js';
import { RelationshipIntentService } from './relationship-intent.service.js';
import { RelationshipService } from './relationship.service.js';

/**
 * Relationship domain module. Pair + Intent own relationship state and transitions. Local conversation
 * state is handled through AccountThreadStateService; source-scoped projections remain independent.
 * The P2P write path (authored and received) runs synchronously through the
 * user intent family exported by FederationModule; this module keeps the
 * remaining relationship projections and query-denial cleanup.
 */
@Module({
  imports: [AccountThreadStateModule, MessageModule],
  providers: [RelationshipService, RelationshipIntentService],
  exports: [RelationshipService, RelationshipIntentService],
})
export class RelationshipModule {}
