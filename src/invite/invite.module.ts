import { Module } from '@nestjs/common';
import { InviteService } from './invite.service.js';
import { ThreadParticipantModule } from '../thread-participant/thread-participant.module.js';
import { MessageModule } from '../message/message.module.js';
import { RelationshipIntentService } from './relationship-intent.service.js';
import { DomainCommandModule } from '../domain-command/domain-command.module.js';
import { SendLocalFriendInviteCommandHandler } from './send-local-friend-invite-command.handler.js';
import { RejectFriendInviteCommandHandler } from './reject-friend-invite-command.handler.js';
import { FriendInviteCommandExecutionService } from './friend-invite-command-execution.service.js';
import { RevokeFriendInviteCommandHandler } from './revoke-friend-invite-command.handler.js';
import { AcceptFriendInviteCommandHandler } from './accept-friend-invite-command.handler.js';

/**
 * Invite domain module. InviteService owns invite state and relationship transitions. Local conversation
 * state is handled through ThreadParticipantService; source-scoped roster projection remains independent.
 */
@Module({
  imports: [ThreadParticipantModule, MessageModule, DomainCommandModule],
  providers: [
    InviteService,
    RelationshipIntentService,
    FriendInviteCommandExecutionService,
    SendLocalFriendInviteCommandHandler,
    AcceptFriendInviteCommandHandler,
    RejectFriendInviteCommandHandler,
    RevokeFriendInviteCommandHandler,
  ],
  exports: [InviteService, RelationshipIntentService],
})
export class InviteModule {}
