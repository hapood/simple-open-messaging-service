import { Module } from '@nestjs/common';
import { InviteService } from './invite.service.js';
import { ThreadParticipantModule } from '../thread-participant/thread-participant.module.js';
import { MessageModule } from '../message/message.module.js';
import { RelationshipIntentService } from './relationship-intent.service.js';

/**
 * Invite domain module. InviteService owns invite DB state + the friend-request badge; it delegates
 * group-member upsert to ThreadParticipantService (the shared raw roster mutator) so accept-group and
 * the federation roster fanout share ONE implementation. Declared in AppModule alongside the controller.
 */
@Module({
  imports: [ThreadParticipantModule, MessageModule],
  providers: [InviteService, RelationshipIntentService],
  exports: [InviteService, RelationshipIntentService],
})
export class InviteModule {}
