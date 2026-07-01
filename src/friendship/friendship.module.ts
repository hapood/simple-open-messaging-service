import { Module } from '@nestjs/common';
import { FriendshipService } from './friendship.service.js';
import { PrismaService } from '../prisma.service.js';
import { NotifyModule } from '../notify/notify.module.js';

@Module({
  // NotifyModule exports NotifyService — FriendshipService arms the friend-request badge atomically
  // inside makeFriendRequest's transaction.
  imports: [NotifyModule],
  providers: [FriendshipService, PrismaService],
  exports: [FriendshipService],
})
export class FriendshipModule {}
