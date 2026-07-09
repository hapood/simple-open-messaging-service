import { Module } from '@nestjs/common';
import { ThreadParticipantService } from './thread-participant.service.js';
import { ThreadAccessGuard } from './thread-access.guard.js';

@Module({
  // ThreadAccessGuard injects ThreadParticipantService to resolve the caller's membership; export it
  // so MessageController and GroupController (both declared in AppModule) can @UseGuards it — group
  // routes reuse it now that groups are `!`-User threads.
  providers: [ThreadParticipantService, ThreadAccessGuard],
  exports: [ThreadParticipantService, ThreadAccessGuard],
})
export class ThreadParticipantModule {}
