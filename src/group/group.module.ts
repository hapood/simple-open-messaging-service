import { Module } from '@nestjs/common';
import { GroupService } from './business/group.service.js';
import { RolesGuard } from './roles.guard.js';
import { MessageModule } from '../message/message.module.js';
import { DurableTaskModule } from '../durable-task/durable-task.module.js';
import { RelationshipModule } from '../relationship/business/relationship.module.js';
import { AccountThreadStateModule } from '../account-thread-state/account-thread-state.module.js';
import { GroupRevokeFanoutService } from './group-revoke-fanout.service.js';
import { DisbandGroupTaskHandler } from './disband-group-task.handler.js';
import { DisbandMirrorGroupMembersTaskHandler } from './disband-mirror-group-members-task.handler.js';
import { ForceRevokeGroupMemberTaskHandler } from './force-revoke-group-member-task.handler.js';
import { RevokeForbiddenGroupTaskHandler } from './revoke-forbidden-group-task.handler.js';
import { GroupMembershipProjectionFanoutService } from './business/membership-intent/shared/group-membership-projection-fanout.service.js';
import { GroupMembershipProjectionFanoutTaskHandler } from './business/membership-intent/shared/group-membership-projection-fanout.handler.js';
import { GroupDisbandMembershipRevocationService } from './business/disband/group-disband-membership-revocation.service.js';
import { MirrorGroupDisbandService } from './business/disband/mirror-group-disband.service.js';
import { DatabaseService } from '../database/database.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { PeerStateFeedService } from '../federation/peer-state-feed.service.js';
import { FederationService } from '../federation/federation.service.js';
import { GroupAuthoredMembershipIntentService } from './business/membership-intent/authored/group-authored-membership-intent.service.js';
import { MemberAuthoredGroupMembershipIntentService } from './business/membership-intent/authored/member-authored-group-membership-intent.service.js';
import { MessageService } from '../message/message.service.js';
import { GroupMetaFeedService } from './business/meta/group-meta-feed.service.js';
import { GroupRosterRoleService } from './business/roster-role/group-roster-role.service.js';
import { GroupRelationshipMutationService } from './business/membership-intent/shared/group-relationship-mutation.service.js';

@Module({
  imports: [
    MessageModule,
    DurableTaskModule,
    RelationshipModule,
    AccountThreadStateModule,
  ],
  // Group routes compose ThreadAccessGuard with RolesGuard. ThreadAccessGuard is exported by
  // AccountThreadStateModule and resolved for the controllers declared in AppModule.
  providers: [
    GroupService,
    RolesGuard,
    GroupRevokeFanoutService,
    DisbandGroupTaskHandler,
    DisbandMirrorGroupMembersTaskHandler,
    ForceRevokeGroupMemberTaskHandler,
    MirrorGroupDisbandService,
    RevokeForbiddenGroupTaskHandler,
    GroupMembershipProjectionFanoutService,
    GroupMembershipProjectionFanoutTaskHandler,
    {
      provide: GroupAuthoredMembershipIntentService,
      useFactory: (
        database: DatabaseService,
        clientFeed: ClientStateFeedService,
        peerFeed: PeerStateFeedService,
        federation: FederationService,
        relationshipMutations: GroupRelationshipMutationService,
      ) =>
        new GroupAuthoredMembershipIntentService({
          database,
          clientFeed,
          peerFeed,
          federation,
          relationshipMutations,
        }),
      inject: [
        DatabaseService,
        ClientStateFeedService,
        PeerStateFeedService,
        FederationService,
        GroupRelationshipMutationService,
      ],
    },
    {
      provide: MemberAuthoredGroupMembershipIntentService,
      useFactory: (
        database: DatabaseService,
        clientFeed: ClientStateFeedService,
        relationshipMutations: GroupRelationshipMutationService,
        federation: FederationService,
      ) =>
        new MemberAuthoredGroupMembershipIntentService({
          database,
          clientFeed,
          relationshipMutations,
          federation,
        }),
      inject: [
        DatabaseService,
        ClientStateFeedService,
        GroupRelationshipMutationService,
        FederationService,
      ],
    },
    {
      provide: GroupRosterRoleService,
      useFactory: (
        database: DatabaseService,
        groupMeta: GroupMetaFeedService,
        messages: MessageService,
      ) =>
        new GroupRosterRoleService({
          database,
          groupMeta,
          messages,
        }),
      inject: [DatabaseService, GroupMetaFeedService, MessageService],
    },
    // The disband revocation owns post-commit feed wakes through its explicit
    // dependency object, so the module wires that object through a factory.
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
  exports: [
    GroupService,
    RolesGuard,
    GroupAuthoredMembershipIntentService,
    MemberAuthoredGroupMembershipIntentService,
    GroupRosterRoleService,
  ],
})
export class GroupModule {}
