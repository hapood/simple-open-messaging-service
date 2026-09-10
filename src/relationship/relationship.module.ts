import { Module } from '@nestjs/common';
import { RelationshipService } from './relationship.service.js';
import { AccountThreadStateModule } from '../account-thread-state/account-thread-state.module.js';
import { MessageModule } from '../message/message.module.js';
import { RelationshipIntentService } from './relationship-intent.service.js';
import { DurableTaskModule } from '../durable-task/durable-task.module.js';
import { SendLocalRelationshipRequestTaskHandler } from './send-local-relationship-request-task.handler.js';
import { RejectRelationshipRequestTaskHandler } from './reject-relationship-request-task.handler.js';
import { RelationshipRequestTaskExecutionService } from './relationship-request-task-execution.service.js';
import { RevokeRelationshipRequestTaskHandler } from './revoke-relationship-request-task.handler.js';
import { AcceptRelationshipRequestTaskHandler } from './accept-relationship-request-task.handler.js';

/**
 * Relationship domain module. Pair + Intent own relationship state and transitions. Local conversation
 * state is handled through AccountThreadStateService; source-scoped projections remain independent.
 */
@Module({
  imports: [AccountThreadStateModule, MessageModule, DurableTaskModule],
  providers: [
    RelationshipService,
    RelationshipIntentService,
    RelationshipRequestTaskExecutionService,
    SendLocalRelationshipRequestTaskHandler,
    AcceptRelationshipRequestTaskHandler,
    RejectRelationshipRequestTaskHandler,
    RevokeRelationshipRequestTaskHandler,
  ],
  exports: [
    RelationshipService,
    RelationshipIntentService,
    RelationshipRequestTaskExecutionService,
  ],
})
export class RelationshipModule {}
