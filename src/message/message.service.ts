import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { ContentType, Prisma } from '../prisma/generated/client.js';

/**
 * Message read/write data layer.
 *
 * Friendship state-machine logic formerly lived here; it has moved to FriendshipService (on the new
 * Friendship model). This service now deals only with Message rows. Membership authorization (is the
 * caller an active ThreadParticipant of this thread?) is handled by ThreadParticipantService in the
 * controllers before write/query is called.
 */
@Injectable()
export class MessageService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {}

  async writeMsgToThread(
    userId: number,
    threadId: number,
    content: string,
    type: ContentType,
  ) {
    const newData = {
      content,
      contentType: type,
      threadId,
      creator: userId,
    };
    const data = await this.prisma.message.create({ data: newData });
    // 返回完整 Message（契约 MessageResponseDto 全字段）。
    // BigInt/Date 由全局 SerializeInterceptor 统一序列化（见 src/common/serialize.interceptor.ts）。
    return data;
  }

  async queryMessages(threadId: number, params: Prisma.MessageFindManyArgs) {
    const data = await this.prisma.message.findMany({
      ...params,
      where: {
        threadId: threadId,
      },
    });
    return data;
  }
}
