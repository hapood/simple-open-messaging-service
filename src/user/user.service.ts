import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User, Prisma, MessageThreadType, UserMessageThreadStatus } from '@prisma/client';
import { AuthService } from 'src/auth/auth.service';
import { StandardResponse } from 'src/model';

@Injectable()
export class UserService implements OnModuleInit {
  constructor(private prisma: PrismaService,
    private auth: AuthService) { }

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
              status: UserMessageThreadStatus.PENDING
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
              status: UserMessageThreadStatus.PENDING
            }
          })
          return {
            status: 0,
            message: 'already requested before'
          }
        } else {
          //don't bother any more when BLOCKED or PENDING
          await prisma.userMessageThread.update({
            where: {
              userId_toObjType_toObjId: {
                userId: fromUserId,
                toObjType: MessageThreadType.P2P_MESSAGE,
                toObjId: toUserId
              },
            },
            data: {
              status: UserMessageThreadStatus.PENDING
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
            threadId: null, userId: fromUserId, toObjId: toUserId,reqMessage:'',
            toObjType: MessageThreadType.P2P_MESSAGE, status: UserMessageThreadStatus.PENDING
          }, {
            threadId: null, userId: toUserId, toObjId: fromUserId,reqMessage:'',
            toObjType: MessageThreadType.P2P_MESSAGE, status: UserMessageThreadStatus.PENDING
          }]
        })
        return {
          status: 0,
          message: 'request sent successful'
        }
      }
    })
  }

  async acceptFriendRequest(fromUserId: number, toUserId: number): Promise<StandardResponse> {
    return await this.prisma.$transaction(async (prisma) => {
      const request = await prisma.userMessageThread.findUnique({
        where: {
          userId_toObjType_toObjId: {
            userId: fromUserId,
            toObjType: MessageThreadType.P2P_MESSAGE,
            toObjId: toUserId
          },
          status: UserMessageThreadStatus.PENDING,
        }
      });
      if (request === null) {
        return {
          status: 1,
          message: `user [${fromUserId}] did not send make friend request to you.`
        }
      }
      let threadId = request.threadId
      if (threadId === null) {
        const threadData = await prisma.messageThread.create({
          data: {
            type: MessageThreadType.P2P_MESSAGE, info: {
              userId1: fromUserId,
              userId2: toUserId
            }
          }
        })
        threadId = threadData.id
      }
      await prisma.userMessageThread.updateMany({
        where: {
          OR: [{
            userId: toUserId,
            toObjType: MessageThreadType.P2P_MESSAGE,
            toObjId: fromUserId
          }, {
            userId: fromUserId,
            toObjType: MessageThreadType.P2P_MESSAGE,
            toObjId: toUserId
          }]
        },
        data: [{
          threadId: threadId, status: UserMessageThreadStatus.APPROVED
        }]
      })
      return {
        status: 0,
        message: 'already been friends'
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

  registerLocal(data: { uniqName: string, password: string }): Promise<StandardResponse> {
    return this.prisma.$transaction(async (prisma) => {
      /*^ Start of string
        (?=[\w.-]{5,20}$) Assert 5-20 of the allowed characters
        (?:[\d_.-]*[a-zA-Z]){3} Match 3 times a-zA-Z followed by optional digits _ . -
        [\w.-]* Match optional word chars or . or -
        $ End of string
      */
      const nameRegex = /^(?=[\w.-]{1,20}$)(?:[\d_.-]*[a-zA-Z]){3}[\w.-]*$/
      const pwdRegex = /^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/
      if (nameRegex.test(data.uniqName) === false) {
        return {
          status: 1, message: `uniqName [${data.uniqName}] not match regex [${nameRegex}]`
        }
      } else if (pwdRegex.test(data.password) === false) {
        return {
          status: 1, message: `uniqName [${data.uniqName}] not match regex [${pwdRegex}]`
        }
      }

      const user = await prisma.user.findUnique({
        where: { uniqName: data.uniqName, domain: null },
      });
      if (user !== null) {
        return {
          status: 2, message: `User ${data.uniqName} already exists`
        }
      }
      const newUserData: Prisma.UserCreateInput = {
        uniqName: data.uniqName,
        isForeigner: false,
        hashPwd: await this.auth.hashStr(data.password),
        userExtra: {
          create: {
            name: data.uniqName,
            avatar: '',
          }
        },
      }
      const newUser = await prisma.user.create({
        data: newUserData
      });
      return {
        status: 0,
        message: 'successfuly registered',
        data: {
          id: newUser.id,
          uniqName: newUser.uniqName
        }
      }
    })
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
}
