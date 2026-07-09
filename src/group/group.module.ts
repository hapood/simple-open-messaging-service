import { Module } from '@nestjs/common';
import { GroupService } from './group.service.js';
import { RolesGuard } from './roles.guard.js';

@Module({
  // GroupAccessGuard is abolished — group routes now use ThreadAccessGuard (groups are `!`-User
  // threads; membership is thread membership). GroupService + RolesGuard are still provided here;
  // ThreadAccessGuard lives in ThreadParticipantModule and is resolved in AppModule's injector.
  providers: [GroupService, RolesGuard],
  exports: [GroupService, RolesGuard],
})
export class GroupModule {}
