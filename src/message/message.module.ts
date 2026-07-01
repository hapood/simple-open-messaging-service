import { Module } from '@nestjs/common';
import { MessageService } from './message.service';
import { PrismaService } from '../prisma.service';
import { NotifyModule } from '../notify/notify.module';

@Module({
  // NotifyModule exports NotifyService — MessageService injects it to write the
  // Notify row + arm the badge atomically inside makeFriendRequest's transaction.
  imports: [NotifyModule],
  providers: [MessageService, PrismaService],
  exports: [MessageService],
})
export class MessageModule {}
