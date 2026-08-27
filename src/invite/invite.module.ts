import { Module } from '@nestjs/common';
import { InviteService } from './invite.service.js';
import { ThreadParticipantModule } from '../thread-participant/thread-participant.module.js';
import { MessageModule } from '../message/message.module.js';
import { RelationshipIntentService } from './relationship-intent.service.js';

/**
 * Invite domain module. InviteService owns invite state and relationship transitions. Local conversation
 * state is handled through ThreadParticipantService; source-scoped roster projection remains independent.
 */
@Module({
  imports: [ThreadParticipantModule, MessageModule],
  providers: [InviteService, RelationshipIntentService],
  exports: [InviteService, RelationshipIntentService],
})
export class InviteModule {}
