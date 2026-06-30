import { ApiProperty } from '@nestjs/swagger';
import {
  ContentType,
  MessageThreadType,
  UserMessageThreadStatus,
} from '../prisma/generated/client';

/**
 * 响应实体 DTO（供 OpenAPI 响应 schema 用）。字段类型反映线上序列化结果，
 * 统一由全局 SerializeInterceptor 完成（见 src/common/serialize.interceptor.ts）：
 * Date → 毫秒时间戳(number)；BigInt（如 Message.id、UserMessageThread.lastRead）→ string。
 *
 * 注意类定义顺序：被 @ApiProperty({ type: X }) 引用的类须先于引用方定义
 * （属性装饰器在类声明时求值，ES class 不提升，否则命中 TDZ → 运行时 ReferenceError）。
 */

export class UserExtraResponseDto {
  @ApiProperty({ example: 'Alice', description: '昵称' })
  name: string;

  @ApiProperty({ example: 'https://.../a.png', description: '头像 URL' })
  avatar: string;

  @ApiProperty({ example: 'Hey there! I am using SOMS.', description: '简介（about）' })
  bio: string;
}

export class UserNotiBoxResponseDto {
  @ApiProperty({ example: false, description: '是否有未读好友请求' })
  hasUrFriendReq: boolean;
}

export class UserResponseDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'alice', description: '登录唯一名' })
  uniqName: string;

  @ApiProperty({ example: false, description: '是否外部用户' })
  isForeigner: boolean;

  @ApiProperty({ example: 'example.com', description: '所属域（可空）' })
  domain?: string;

  @ApiProperty({ example: 1_700_000_000_000, description: '创建时间（毫秒时间戳）' })
  createdAt: number;

  @ApiProperty({ example: 1_700_000_000_000, description: '更新时间（毫秒时间戳）' })
  updatedAt: number;

  @ApiProperty({ example: false })
  isDeleted: boolean;

  @ApiProperty({ description: '用户扩展信息' })
  userExtra: UserExtraResponseDto;

  @ApiProperty({ description: '通知盒子' })
  userNotiBox: UserNotiBoxResponseDto;

  // 注意：hashPwd 永不出现在响应里
}

export class MessageResponseDto {
  @ApiProperty({ example: '9007199254740993', description: '消息 id（BigInt→string）' })
  id: string;

  @ApiProperty({ enum: ContentType, description: '消息内容类型' })
  contentType: ContentType;

  @ApiProperty({ example: 'hello', description: '消息内容' })
  content: string;

  @ApiProperty({ example: 12, description: '所属会话 id' })
  threadId: number;

  @ApiProperty({ example: 1, description: '发送者 userId' })
  creator: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  createdAt: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  updatedAt: number;

  @ApiProperty({ example: false })
  isDeleted: boolean;
}

export class GroupResponseDto {
  @ApiProperty({ example: 12 })
  id: number;

  @ApiProperty({ example: 'dev-team', description: '群名' })
  name: string;

  @ApiProperty({ example: 1, description: '群主 userId' })
  ownerId: number;

  @ApiProperty({ example: 'https://.../g.png', description: '群头像 URL' })
  avatar: string;

  @ApiProperty({ example: 12, description: '群消息线程 id' })
  threadId: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  createdAt: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  updatedAt: number;
}

export class UserMessageThreadResponseDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 1, description: '所属用户 id' })
  userId: number;

  @ApiProperty({
    enum: UserMessageThreadStatus,
    description: '会话状态（域枚举，非响应信封 code）',
  })
  status: UserMessageThreadStatus;

  @ApiProperty({ enum: MessageThreadType, description: '对端类型 P2P|GROUP' })
  toObjType: MessageThreadType;

  @ApiProperty({ example: 2, description: '对端 id（userId 或 groupId）' })
  toObjId: number;

  @ApiProperty({ example: '', description: '好友请求附言' })
  reqMessage: string;

  @ApiProperty({ example: 12, description: '底层消息线程 id（可空）' })
  threadId?: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  createdAt: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  updatedAt: number;

  @ApiProperty({ example: false })
  isDeleted: boolean;

  @ApiProperty({
    example: '9007199254740993',
    description: '已读位置（BigInt→string，可空）',
  })
  lastRead?: string;

  // P2P 项附带 userItem: UserResponseDto；GROUP 项附带 groupItem: GroupResponseDto
  @ApiProperty({ type: UserResponseDto, description: '对端用户（P2P 时）' })
  userItem?: UserResponseDto;

  @ApiProperty({ type: GroupResponseDto, description: '对端群组（GROUP 时）' })
  groupItem?: GroupResponseDto;
}

export class CreateGroupResponseDto {
  @ApiProperty({ example: 12, description: '群消息线程 id' })
  threadId: number;

  @ApiProperty({ example: 12, description: '群 id' })
  groupId: number;
}
