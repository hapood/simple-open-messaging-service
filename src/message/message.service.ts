import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ContentType, Prisma, UserMessageThreadStatus, MessageThreadType } from '@prisma/client';
@Injectable()
export class MessageService implements OnModuleInit {
  constructor(private prisma: PrismaService) { }

  async onModuleInit() {
  }

  findUniqueUserMessageThread(
    params: Prisma.UserMessageThreadWhereUniqueInput,
  ) {
    return this.prisma.userMessageThread.findUnique({
      where: params,
      include: {
        threadItem: true
      }
    });
  }

  async writeMsgToThread(userId: number, threadId: number, content: string, type: ContentType) {
    const newData = {
      content,
      contentType: type,
      threadId,
      creator: userId
    }
    const data = await this.prisma.message.create({ data: newData });
    return {
      id: data.id,
      createdAt: data.createdAt
    }
  }

  async queryMessages(threadId: number, params: Prisma.MessageFindManyArgs) {
    const data = await this.prisma.message.findMany({
      ...params,
      where: {
        threadId: threadId,
      }
    });
    return data
  }

  async getFriendship(params: { userId: number, friendUserId: number }) {
    const userMsgTr = await this.findUniqueUserMessageThread({
      userId_toObjType_toObjId: {
        userId: params.userId,
        toObjType: MessageThreadType.P2P_MESSAGE,
        toObjId: params.friendUserId
      }
    })
    const friendMsgTr = await this.findUniqueUserMessageThread({
      userId_threadId: {
        userId: userMsgTr.toObjId,
        threadId: userMsgTr.threadId
      }
    })
    return {
      isFriend: friendMsgTr?.status === UserMessageThreadStatus.APPROVED
        && userMsgTr?.status === UserMessageThreadStatus.APPROVED,
      userMsgTr,
      friendMsgTr
    }
  }

  makeFriendRequest(fromUserId: number, toUserId: number) {
    return this.prisma.$transaction(async (prisma) => {
      const toUserThread = await prisma.userMessageThread.findUnique({
        where: {
          userId_toObjType_toObjId: {
            userId: toUserId,
            toObjType: MessageThreadType.P2P_MESSAGE,
            toObjId: fromUserId
          },
        }
      })
      if (toUserThread) {
        // not first make firend request
        if (toUserThread.status === UserMessageThreadStatus.APPROVED) {
          //toUserThread exist then fromUserThread exist too.
          await prisma.userMessageThread.update({
            where: {
              userId_toObjType_toObjId: {
                userId: fromUserId,
                toObjType: MessageThreadType.P2P_MESSAGE,
                toObjId: toUserId
              },
            },
            data: {
              status: UserMessageThreadStatus.APPROVED
            }
          })
          return {
            //already been friends
            status: 1,
          }
        } else if (toUserThread.status === UserMessageThreadStatus.DELETED) {
          //both reset to PENDING
          await prisma.userMessageThread.update({
            where: {
              userId_toObjType_toObjId: {
                userId: fromUserId,
                toObjType: MessageThreadType.P2P_MESSAGE,
                toObjId: toUserId
              },
            },
            data: {
              status: UserMessageThreadStatus.FROM_PENDING
            }
          })
          await prisma.userMessageThread.update({
            where: {
              userId_toObjType_toObjId: {
                userId: toUserId,
                toObjType: MessageThreadType.P2P_MESSAGE,
                toObjId: fromUserId
              },
            },
            data: {
              status: UserMessageThreadStatus.TO_PENDING
            }
          })
          return {
            //deleted and reset to TO_PENDING
            status: 2,
          }
        } else if (toUserThread.status === UserMessageThreadStatus.FROM_PENDING) {
          const res = await this.approveFriendRequest(fromUserId, toUserId)
          if (res.status === 0) {
            //firend is FROM_PENDING, set to APPROVED
            return { status: 3 }
          } else {
            return {
              // firend is FROM_PENDING, make friend error,should not happened
              status: 4,
            }
          }
        } else {
          //don't bother any more when BLOCKED or TO_PENDING
          await prisma.userMessageThread.update({
            where: {
              userId_toObjType_toObjId: {
                userId: fromUserId,
                toObjType: MessageThreadType.P2P_MESSAGE,
                toObjId: toUserId
              },
            },
            data: {
              status: UserMessageThreadStatus.FROM_PENDING
            }
          })
          return {
            status: 5,
          }
        }
      } else {
        await prisma.userMessageThread.createMany({
          data: [{
            threadId: null, userId: fromUserId, toObjId: toUserId, reqMessage: '',
            toObjType: MessageThreadType.P2P_MESSAGE, status: UserMessageThreadStatus.FROM_PENDING
          }, {
            threadId: null, userId: toUserId, toObjId: fromUserId, reqMessage: '',
            toObjType: MessageThreadType.P2P_MESSAGE, status: UserMessageThreadStatus.TO_PENDING
          }]
        })
        return {
          status: 0,
        }
      }
    })
  }

  async approveFriendRequest(fromUserId: number, toUserId: number) {
    return await this.prisma.$transaction(async (prisma) => {
      const request = await prisma.userMessageThread.findUnique({
        where: {
          userId_toObjType_toObjId: {
            userId: fromUserId,
            toObjType: MessageThreadType.P2P_MESSAGE,
            toObjId: toUserId
          },
        }
      });
      if (request !== null && request.status === UserMessageThreadStatus.FROM_PENDING) {
        const myRequest = await prisma.userMessageThread.findUnique({
          where: {
            userId_toObjType_toObjId: {
              userId: toUserId,
              toObjType: MessageThreadType.P2P_MESSAGE,
              toObjId: fromUserId
            },
          }
        });
        let threadId = request.threadId
        if (threadId === null) {
          const threadData = await prisma.messageThread.create({
            data: {
              type: MessageThreadType.P2P_MESSAGE
            }
          })
          threadId = threadData.id
        }
        await prisma.userMessageThread.update({
          where: {
            userId_toObjType_toObjId: {
              userId: fromUserId,
              toObjType: MessageThreadType.P2P_MESSAGE,
              toObjId: toUserId
            },
          },
          data: {
            threadId: threadId, status: UserMessageThreadStatus.APPROVED
          }
        })
        if (myRequest.status !== UserMessageThreadStatus.APPROVED) {
          await prisma.userMessageThread.update({
            where: {
              userId_toObjType_toObjId: {
                userId: toUserId,
                toObjType: MessageThreadType.P2P_MESSAGE,
                toObjId: fromUserId
              },
            },
            data: {
              threadId: threadId, status: UserMessageThreadStatus.APPROVED
            }
          })
        }
        return {
          status: 0,
        }
      } else {
        return {
          status: 1,
        }
      }
    })
  }

}