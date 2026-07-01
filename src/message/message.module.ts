import { Module } from '@nestjs/common';
import { MessageService } from './message.service.js';
import { PrismaService } from '../prisma.service.js';
import { NotifyModule } from '../notify/notify.module.js';

@Module({
  // NotifyModule exports NotifyService — MessageService injects it to write the
  // Notify row + arm the badge atomically inside makeFriendRequest's transaction.
  imports: [NotifyModule],
  providers: [MessageService, PrismaService],
  exports: [MessageService],
})
export class MessageModule {}
