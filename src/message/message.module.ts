import { Module } from '@nestjs/common';
import { MessageService } from './message.service.js';

@Module({
  // Friendship logic moved to FriendshipModule; MessageService is now a thin Message read/write layer
  // with no Notify dependency.
  providers: [MessageService],
  exports: [MessageService],
})
export class MessageModule {}
