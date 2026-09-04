import { Module } from '@nestjs/common';
import { GroupService } from './group.service.js';
import { RolesGuard } from './roles.guard.js';
import { MessageModule } from '../message/message.module.js';
import { DurableTaskModule } from '../durable-task/durable-task.module.js';
import { RelationshipModule } from '../relationship/relationship.module.js';
import { AccountThreadStateModule } from '../account-thread-state/account-thread-state.module.js';
import { GroupDisbandFanoutService } from './group-disband-fanout.service.js';
import { DisbandGroupTaskHandler } from './disband-group-task.handler.js';
import { RevokeDissolvedGroupMemberTaskHandler } from './revoke-dissolved-group-member-task.handler.js';
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
    GroupDisbandFanoutService,
    DisbandGroupTaskHandler,
    RevokeDissolvedGroupMemberTaskHandler,
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
  ],
  exports: [GroupService, RolesGuard],
})
export class GroupModule {}
