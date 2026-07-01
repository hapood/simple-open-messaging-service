import { Module } from '@nestjs/common';
import { NotifyService } from './notify.service.js';
import { PrismaService } from '../prisma.service.js';

@Module({
  providers: [NotifyService, PrismaService],
  exports: [NotifyService],
})
export class NotifyModule {}
