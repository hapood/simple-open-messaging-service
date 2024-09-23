import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User, Prisma, MessageThreadType, UserMessageThreadStatus } from '@prisma/client';
import { StandardResponse } from 'src/model';

@Injectable()
export class UserService implements OnModuleInit {
  constructor(private prisma: PrismaService) { }

  async onModuleInit() {
  }

  makeFriendRequest(fromUserId: number, toUserId: number): Promise<StandardResponse> {
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
            status: 1,
            message: 'already been friends'
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
            status: 0,
            message: 'already requested before'
          }
        } else if (toUserThread.status === UserMessageThreadStatus.FROM_PENDING) {
          const res = await this.approveFriendRequest(fromUserId, toUserId)
          if (res.status === 0) {
            return res
          } else {
            return {
              status: 3,
              message: res.message
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
            status: 2,
            message: 'request sent successful'
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
          message: 'request sent successful'
        }
      }
    })
  }

  async approveFriendRequest(fromUserId: number, toUserId: number): Promise<StandardResponse> {
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
          message: 'already been friends'
        }
      } else {
        return {
          status: 1,
          message: `user [${fromUserId}] did not send make friend request to you.`
        }
      }
    })
  }

  findUniqueUser(
    userWhereUniqueInput: Prisma.UserWhereUniqueInput,
    hasExtra = true
  ) {
    return this.prisma.user.findUnique({
      where: userWhereUniqueInput,
      include: {
        userExtra: hasExtra,
      },
    });
  }

  updateUser(params: {
    where: Prisma.UserWhereUniqueInput;
    data: Prisma.UserUpdateInput;
  }): Promise<User> {
    const { where, data } = params;
    return this.prisma.user.update({
      data,
      where,
    });
  }

  updateUserExtra(params: {
    where: Prisma.UserWhereUniqueInput;
    data: Prisma.UserUpdateInput;
  }): Promise<User> {
    const { where, data } = params;
    return this.prisma.user.update({
      data,
      where,
    });
  }

  queryUserThread(params: Prisma.UserMessageThreadFindManyArgs) {
    return this.prisma.userMessageThread.findMany(params)
  }

  queryUsers(params: Prisma.UserFindManyArgs) {
    return this.prisma.user.findMany(params)
  }

  addUser(params: { uniqName: string, hashPwd: string }) {
    return this.prisma.$transaction(async (prisma) => {
      const user = await prisma.user.findUnique({
        where: { uniqName: params.uniqName, domain: null },
      });
      if (user !== null) {
        return {
          status: 2
        }
      }
      const newUserData: Prisma.UserCreateInput = {
        uniqName: params.uniqName,
        isForeigner: false,
        hashPwd: params.hashPwd,
        userExtra: {
          create: {
            name: params.uniqName,
            avatar: '',
          }
        },
        userNotiBox: {
          create: {
          }
        }
      }
      const newUser = await prisma.user.create({
        data: newUserData
      });
      return {
        status: 0,
        data: {
          id: newUser.id,
          uniqName: newUser.uniqName
        }
      }
    })
  }
}
