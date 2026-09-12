import { Module } from '@nestjs/common';
import { GroupService } from './group.service.js';
import { RolesGuard } from './roles.guard.js';
import { MessageModule } from '../message/message.module.js';
import { DurableTaskModule } from '../durable-task/durable-task.module.js';
import { RelationshipModule } from '../relationship/relationship.module.js';
import { AccountThreadStateModule } from '../account-thread-state/account-thread-state.module.js';
import { GroupRevokeFanoutService } from './group-revoke-fanout.service.js';
import { DisbandGroupTaskHandler } from './disband-group-task.handler.js';
import { ForceRevokeGroupMemberTaskHandler } from './force-revoke-group-member-task.handler.js';
import { RevokeForbiddenGroupTaskHandler } from './revoke-forbidden-group-task.handler.js';
import {
  KickGroupMemberTaskHandler,
  LeaveGroupTaskHandler,
  SetGroupMemberRoleTaskHandler,
  TransferGroupOwnershipTaskHandler,
} from './group-membership-task.handlers.js';
import { GroupInviteTaskExecutionService } from './group-invite-task-execution.service.js';
import {
  AcceptGroupJoinRequestTaskHandler,
  AcceptGroupInvitationTaskHandler,
  InviteGroupMemberTaskHandler,
  RejectGroupJoinRequestTaskHandler,
  RevokeGroupInvitationTaskHandler,
} from './group-request-task.handlers.js';
import { GroupMembershipProjectionFanoutService } from '../business/group/membership-intent/group-membership-projection-fanout.service.js';
import { GroupMembershipProjectionFanoutTaskHandler } from '../business/group/membership-intent/group-membership-projection-fanout.handler.js';
import { GroupDisbandMembershipRevocationService } from '../business/group/disband/group-disband-membership-revocation.service.js';
import { DatabaseService } from '../database/database.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { PeerStateFeedService } from '../federation/peer-state-feed.service.js';
import { FederationService } from '../federation/federation.service.js';

@Module({
  imports: [
    MessageModule,
    DurableTaskModule,
    RelationshipModule,
    AccountThreadStateModule,
  ],
  // GroupAccessGuard is abolished — group routes now use ThreadAccessGuard (groups are `!`-User
  // threads; membership is thread membership). GroupService + RolesGuard are still provided here;
  // ThreadAccessGuard lives in AccountThreadStateModule and is resolved in AppModule's injector.
  providers: [
    GroupService,
    RolesGuard,
    GroupRevokeFanoutService,
    DisbandGroupTaskHandler,
    ForceRevokeGroupMemberTaskHandler,
    RevokeForbiddenGroupTaskHandler,
    LeaveGroupTaskHandler,
    KickGroupMemberTaskHandler,
    TransferGroupOwnershipTaskHandler,
    SetGroupMemberRoleTaskHandler,
    GroupInviteTaskExecutionService,
    InviteGroupMemberTaskHandler,
    AcceptGroupJoinRequestTaskHandler,
    RejectGroupJoinRequestTaskHandler,
    RevokeGroupInvitationTaskHandler,
    AcceptGroupInvitationTaskHandler,
    GroupMembershipProjectionFanoutService,
    GroupMembershipProjectionFanoutTaskHandler,
    // The disband revocation keeps the experiment-family deps-object
    // constructor, so the module wires it through a factory.
    {
      provide: GroupDisbandMembershipRevocationService,
      useFactory: (
        database: DatabaseService,
        clientFeed: ClientStateFeedService,
        peerFeed: PeerStateFeedService,
        federation: FederationService,
      ) =>
        new GroupDisbandMembershipRevocationService({
          database,
          clientFeed,
          peerFeed,
          federation,
        }),
      inject: [
        DatabaseService,
        ClientStateFeedService,
        PeerStateFeedService,
        FederationService,
      ],
    },
  ],
  exports: [GroupService, RolesGuard],
})
export class GroupModule {}
