import { Module } from '@nestjs/common';
import { ThreadParticipantService } from './thread-participant.service.js';
import { ThreadAccessGuard } from './thread-access.guard.js';
import { PrismaService } from '../prisma.service.js';

@Module({
  // ThreadAccessGuard injects ThreadParticipantService to resolve the caller's membership; export it
  // so MessageController (declared in AppModule) can @UseGuards it — same shape as GroupModule
  // exporting GroupAccessGuard for GroupController.
  providers: [ThreadParticipantService, PrismaService, ThreadAccessGuard],
  exports: [ThreadParticipantService, ThreadAccessGuard],
})
export class ThreadParticipantModule {}
