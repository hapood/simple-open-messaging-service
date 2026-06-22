import { Module } from '@nestjs/common';
import { GroupService } from './group.service';
import { PrismaService } from '../prisma.service';

@Module({
  providers: [GroupService, PrismaService],
  exports: [GroupService],
})
export class GroupModule {}
