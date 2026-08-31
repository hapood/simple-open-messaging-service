import { Module } from '@nestjs/common';
import { ThreadParticipantService } from './thread-participant.service.js';
import { ThreadAccessGuard } from './thread-access.guard.js';
import { MessageModule } from '../message/message.module.js';
import { DomainCommandModule } from '../domain-command/domain-command.module.js';
import { EndFriendshipCommandHandler } from './end-friendship-command.handler.js';

@Module({
  // ThreadAccessGuard injects ThreadParticipantService to resolve the caller's membership; export it
  // so MessageController and GroupController (both declared in AppModule) can @UseGuards it — group
  // routes reuse it now that groups are `!`-User threads.
  imports: [MessageModule, DomainCommandModule],
  providers: [
    ThreadParticipantService,
    ThreadAccessGuard,
    EndFriendshipCommandHandler,
  ],
  exports: [ThreadParticipantService, ThreadAccessGuard],
})
export class ThreadParticipantModule {}
