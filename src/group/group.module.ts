import { Module } from '@nestjs/common';
import { GroupService } from './group.service.js';
import { PrismaService } from '../prisma.service.js';

@Module({
  providers: [GroupService, PrismaService],
  exports: [GroupService],
})
export class GroupModule {}
