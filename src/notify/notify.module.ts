import { Module } from '@nestjs/common';
import { NotifyService } from './notify.service';
import { PrismaService } from '../prisma.service';

@Module({
  providers: [NotifyService, PrismaService],
  exports: [NotifyService],
})
export class NotifyModule { }