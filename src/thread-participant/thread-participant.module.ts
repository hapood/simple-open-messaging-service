import { Module } from '@nestjs/common';
import { ThreadParticipantService } from './thread-participant.service.js';
import { PrismaService } from '../prisma.service.js';

@Module({
  providers: [ThreadParticipantService, PrismaService],
  exports: [ThreadParticipantService],
})
export class ThreadParticipantModule {}
