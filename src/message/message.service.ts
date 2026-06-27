import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  ContentType,
  Prisma,
  UserMessageThreadStatus,
  MessageThreadType,
} from '../prisma/generated/client';
@Injectable()
export class MessageService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {}

  findUniqueUserMessageThread(params: Prisma.UserMessageThreadFindUniqueArgs) {
    return this.prisma.userMessageThread.findUnique(params);
  }

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

  async getFriendship(params: { userId: number; friendUserId: number }) {
    const userMsgTr = await this.findUniqueUserMessageThread({
      where: {
        userId_toObjType_toObjId: {
          userId: params.userId,
          toObjType: MessageThreadType.P2P,
          toObjId: params.friendUserId,
        },
      },
    });
    if (userMsgTr === null) {
      return {
        isFriend: false,
        userMsgTr: null,
        friendMsgTr: null,
      };
    }
    const friendMsgTr = await this.findUniqueUserMessageThread({
      where: {
        userId_threadId: {
          userId: userMsgTr.toObjId,
          threadId: userMsgTr.threadId,
        },
      },
    });
    return {
      isFriend:
        friendMsgTr?.status === UserMessageThreadStatus.APPROVED &&
        userMsgTr?.status === UserMessageThreadStatus.APPROVED,
      userMsgTr,
      friendMsgTr,
    };
  }

  makeFriendRequest(fromUserId: number, toUserId: number) {
    return this.prisma.$transaction(async (prisma) => {
      const toUserThread = await prisma.userMessageThread.findUnique({
        where: {
          userId_toObjType_toObjId: {
            userId: toUserId,
            toObjType: MessageThreadType.P2P,
            toObjId: fromUserId,
          },
        },
      });
      if (toUserThread) {
        // not first make firend request
        if (toUserThread.status === UserMessageThreadStatus.APPROVED) {
          //toUserThread exist then fromUserThread exist too.
          await prisma.userMessageThread.update({
            where: {
              userId_toObjType_toObjId: {
                userId: fromUserId,
                toObjType: MessageThreadType.P2P,
                toObjId: toUserId,
              },
            },
            data: {
              status: UserMessageThreadStatus.APPROVED,
            },
          });
          return {
            //already been friends
            status: 1,
          };
        } else if (toUserThread.status === UserMessageThreadStatus.DELETED) {
          //both reset to PENDING
          await prisma.userMessageThread.update({
            where: {
              userId_toObjType_toObjId: {
                userId: fromUserId,
                toObjType: MessageThreadType.P2P,
                toObjId: toUserId,
              },
            },
            data: {
              status: UserMessageThreadStatus.FROM_PENDING,
            },
          });
          await prisma.userMessageThread.update({
            where: {
              userId_toObjType_toObjId: {
                userId: toUserId,
                toObjType: MessageThreadType.P2P,
                toObjId: fromUserId,
              },
            },
            data: {
              status: UserMessageThreadStatus.TO_PENDING,
            },
          });
          return {
            //deleted and reset to TO_PENDING
            status: 2,
          };
        } else if (
          toUserThread.status === UserMessageThreadStatus.FROM_PENDING
        ) {
          // toUserThread(userId=toUserId) 为 FROM_PENDING，说明对端先发过请求 → 双向意愿，直接互加。
          // approveFriendRequest(X, Y) 要求 X 的行为 FROM_PENDING，故 X=toUserId、Y=fromUserId。
          // （原实现误传 (fromUserId, toUserId)，导致 X 的行不是 FROM_PENDING → 恒返回 status 4。）
          const res = await this.approveFriendRequest(toUserId, fromUserId);
          if (res.status === 0) {
            //对端 FROM_PENDING，已双双置 APPROVED
            return { status: 3 };
          } else {
            return {
              // firend is FROM_PENDING, make friend error,should not happened
              status: 4,
            };
          }
        } else {
          //don't bother any more when BLOCKED or TO_PENDING
          await prisma.userMessageThread.update({
            where: {
              userId_toObjType_toObjId: {
                userId: fromUserId,
                toObjType: MessageThreadType.P2P,
                toObjId: toUserId,
              },
            },
            data: {
              status: UserMessageThreadStatus.FROM_PENDING,
            },
          });
          return {
            status: 5,
          };
        }
      } else {
        await prisma.userMessageThread.createMany({
          data: [
            {
              threadId: null,
              userId: fromUserId,
              toObjId: toUserId,
              reqMessage: '',
              toObjType: MessageThreadType.P2P,
              status: UserMessageThreadStatus.FROM_PENDING,
            },
            {
              threadId: null,
              userId: toUserId,
              toObjId: fromUserId,
              reqMessage: '',
              toObjType: MessageThreadType.P2P,
              status: UserMessageThreadStatus.TO_PENDING,
            },
          ],
        });
        return {
          status: 0,
        };
      }
    });
  }

  async approveFriendRequest(fromUserId: number, toUserId: number) {
    return await this.prisma.$transaction(async (prisma) => {
      const request = await prisma.userMessageThread.findUnique({
        where: {
          userId_toObjType_toObjId: {
            userId: fromUserId,
            toObjType: MessageThreadType.P2P,
            toObjId: toUserId,
          },
        },
      });
      if (
        request !== null &&
        request.status === UserMessageThreadStatus.FROM_PENDING
      ) {
        const myRequest = await prisma.userMessageThread.findUnique({
          where: {
            userId_toObjType_toObjId: {
              userId: toUserId,
              toObjType: MessageThreadType.P2P,
              toObjId: fromUserId,
            },
          },
        });
        let threadId = request.threadId;
        if (threadId === null) {
          const threadData = await prisma.messageThread.create({
            data: {
              type: MessageThreadType.P2P,
            },
          });
          threadId = threadData.id;
        }
        await prisma.userMessageThread.update({
          where: {
            userId_toObjType_toObjId: {
              userId: fromUserId,
              toObjType: MessageThreadType.P2P,
              toObjId: toUserId,
            },
          },
          data: {
            threadId: threadId,
            status: UserMessageThreadStatus.APPROVED,
          },
        });
        if (myRequest.status !== UserMessageThreadStatus.APPROVED) {
          await prisma.userMessageThread.update({
            where: {
              userId_toObjType_toObjId: {
                userId: toUserId,
                toObjType: MessageThreadType.P2P,
                toObjId: fromUserId,
              },
            },
            data: {
              threadId: threadId,
              status: UserMessageThreadStatus.APPROVED,
            },
          });
        }
        return {
          status: 0,
        };
      } else {
        return {
          status: 1,
        };
      }
    });
  }

  /**
   * 拒绝好友请求：删除这对请求行（请求方 FROM_PENDING + 我 TO_PENDING）。
   * 语义对标 Telegram——拒绝后请求从我的待处理列表消失，且不通知对方；关系回到
   * 「无任何记录」的初始态，对方之后仍可重新发起（makeFriendRequest 的首次请求分支）。
   *
   * 入参与 approveFriendRequest 一致：fromUserId=请求方，toUserId=我（拒绝者）。
   * 仅当请求方行确为 FROM_PENDING（确有待处理请求）才删除；否则返回 status 1（无可拒绝对象）。
   * 待处理阶段 threadId 为 null（MessageThread 仅在同意时创建），删除请求行不会产生孤立会话。
   */
  async declineFriendRequest(fromUserId: number, toUserId: number) {
    return await this.prisma.$transaction(async (prisma) => {
      const request = await prisma.userMessageThread.findUnique({
        where: {
          userId_toObjType_toObjId: {
            userId: fromUserId,
            toObjType: MessageThreadType.P2P,
            toObjId: toUserId,
          },
        },
      });
      if (
        request === null ||
        request.status !== UserMessageThreadStatus.FROM_PENDING
      ) {
        return { status: 1 };
      }
      await prisma.userMessageThread.deleteMany({
        where: {
          OR: [
            {
              userId: fromUserId,
              toObjType: MessageThreadType.P2P,
              toObjId: toUserId,
            },
            {
              userId: toUserId,
              toObjType: MessageThreadType.P2P,
              toObjId: fromUserId,
            },
          ],
        },
      });
      return { status: 0 };
    });
  }
}
