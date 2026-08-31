import { Module } from '@nestjs/common';
import { GroupService } from './group.service.js';
import { RolesGuard } from './roles.guard.js';
import { MessageModule } from '../message/message.module.js';
import { DomainCommandModule } from '../domain-command/domain-command.module.js';
import { InviteModule } from '../invite/invite.module.js';
import { ThreadParticipantModule } from '../thread-participant/thread-participant.module.js';
import { GroupDisbandFanoutService } from './group-disband-fanout.service.js';
import { DisbandGroupCommandHandler } from './disband-group-command.handler.js';
import { RevokeDissolvedGroupMemberCommandHandler } from './revoke-dissolved-group-member-command.handler.js';
import {
  KickGroupMemberCommandHandler,
  LeaveGroupCommandHandler,
  SetGroupMemberRoleCommandHandler,
  TransferGroupOwnershipCommandHandler,
} from './group-membership-command.handlers.js';
import { GroupInviteCommandExecutionService } from './group-invite-command-execution.service.js';
import {
  AcceptGroupJoinRequestCommandHandler,
  AcceptGroupInvitationCommandHandler,
  InviteGroupMemberCommandHandler,
  RejectGroupJoinRequestCommandHandler,
  RevokeGroupInvitationCommandHandler,
} from './group-request-command.handlers.js';

@Module({
  imports: [
    MessageModule,
    DomainCommandModule,
    InviteModule,
    ThreadParticipantModule,
  ],
  // GroupAccessGuard is abolished — group routes now use ThreadAccessGuard (groups are `!`-User
  // threads; membership is thread membership). GroupService + RolesGuard are still provided here;
  // ThreadAccessGuard lives in ThreadParticipantModule and is resolved in AppModule's injector.
  providers: [
    GroupService,
    RolesGuard,
    GroupDisbandFanoutService,
    DisbandGroupCommandHandler,
    RevokeDissolvedGroupMemberCommandHandler,
    LeaveGroupCommandHandler,
    KickGroupMemberCommandHandler,
    TransferGroupOwnershipCommandHandler,
    SetGroupMemberRoleCommandHandler,
    GroupInviteCommandExecutionService,
    InviteGroupMemberCommandHandler,
    AcceptGroupJoinRequestCommandHandler,
    RejectGroupJoinRequestCommandHandler,
    RevokeGroupInvitationCommandHandler,
    AcceptGroupInvitationCommandHandler,
  ],
  exports: [GroupService, RolesGuard],
})
export class GroupModule {}
