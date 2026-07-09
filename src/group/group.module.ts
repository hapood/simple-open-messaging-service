import { Module } from '@nestjs/common';
import { GroupService } from './group.service.js';
import { GroupAccessGuard } from './group-access.guard.js';
import { RolesGuard } from './roles.guard.js';
import { ThreadParticipantModule } from '../thread-participant/thread-participant.module.js';

@Module({
  // ThreadParticipantModule exports ThreadParticipantService, which GroupAccessGuard injects to
  // resolve the caller's membership. Guards are exported so GroupController (declared in
  // AppModule) can use them via @UseGuards; their constructor deps are all resolvable in
  // AppModule's injector.
  imports: [ThreadParticipantModule],
  providers: [GroupService, GroupAccessGuard, RolesGuard],
  exports: [GroupService, GroupAccessGuard, RolesGuard],
})
export class GroupModule {}
