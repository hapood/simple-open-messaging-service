import { Module } from '@nestjs/common';
import { FriendshipService } from './friendship.service.js';
import { NotifyModule } from '../notify/notify.module.js';

@Module({
  // NotifyModule exports NotifyService — FriendshipService arms the friend-request badge atomically
  // inside makeFriendRequest's transaction.
  imports: [NotifyModule],
  providers: [FriendshipService],
  exports: [FriendshipService],
})
export class FriendshipModule {}
