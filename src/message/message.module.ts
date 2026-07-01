import { Module } from '@nestjs/common';
import { MessageService } from './message.service.js';
import { PrismaService } from '../prisma.service.js';

@Module({
  // Friendship logic moved to FriendshipModule; MessageService is now a thin Message read/write layer
  // with no Notify dependency.
  providers: [MessageService, PrismaService],
  exports: [MessageService],
})
export class MessageModule {}
