import { ApiProperty } from '@nestjs/swagger';
import {
  ContentType,
  MessageThreadType,
  UserMessageThreadStatus,
} from '../prisma/generated/client.js';

/**
 * Response entity DTOs (for OpenAPI response schemas). Field types reflect the on-the-wire serialized
 * result, uniformly applied by the global SerializeInterceptor (see src/common/serialize.interceptor.ts):
 * Date → millisecond timestamp (number); BigInt (e.g. Message.id, UserMessageThread.lastRead) → string.
 *
 * Note on class definition order: a class referenced via @ApiProperty({ type: X }) must be declared
 * before the class that references it (property decorators are evaluated at class-declaration time; ES
 * classes are not hoisted — otherwise you hit the TDZ → runtime ReferenceError).
 */

export class UserExtraResponseDto {
  @ApiProperty({ example: 'Alice', description: 'Display name' })
  name: string;

  @ApiProperty({ example: 'https://.../a.png', description: 'Avatar URL' })
  avatar: string;

  @ApiProperty({ example: 'Hey there! I am using SOMS.', description: 'Bio (about)' })
  bio: string;
}

export class UserNotiBoxResponseDto {
  @ApiProperty({ example: false, description: 'Whether there are unread friend requests' })
  hasUrFriendReq: boolean;
}

export class UserResponseDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'alice', description: 'Login unique name' })
  uniqName: string;

  @ApiProperty({ example: false, description: 'Whether an external user' })
  isForeigner: boolean;

  @ApiProperty({ example: 'example.com', description: 'Domain (nullable)' })
  domain?: string;

  @ApiProperty({ example: 1_700_000_000_000, description: 'Created at (ms timestamp)' })
  createdAt: number;

  @ApiProperty({ example: 1_700_000_000_000, description: 'Updated at (ms timestamp)' })
  updatedAt: number;

  @ApiProperty({ example: false })
  isDeleted: boolean;

  @ApiProperty({ description: 'User extra info' })
  userExtra: UserExtraResponseDto;

  @ApiProperty({ description: 'Notification box' })
  userNotiBox: UserNotiBoxResponseDto;

  // Note: hashPwd never appears in responses.
}

export class MessageResponseDto {
  @ApiProperty({ example: '9007199254740993', description: 'Message id (BigInt→string)' })
  id: string;

  @ApiProperty({ enum: ContentType, description: 'Content type' })
  contentType: ContentType;

  @ApiProperty({ example: 'hello', description: 'Message content' })
  content: string;

  @ApiProperty({ example: 12, description: 'Owning thread id' })
  threadId: number;

  @ApiProperty({ example: 1, description: 'Sender userId' })
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

  @ApiProperty({ example: 'dev-team', description: 'Group name' })
  name: string;

  @ApiProperty({ example: 1, description: 'Owner userId' })
  ownerId: number;

  @ApiProperty({ example: 'https://.../g.png', description: 'Group avatar URL' })
  avatar: string;

  @ApiProperty({ example: 12, description: 'Group message thread id' })
  threadId: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  createdAt: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  updatedAt: number;
}

export class UserMessageThreadResponseDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 1, description: 'Owning user id' })
  userId: number;

  @ApiProperty({
    enum: UserMessageThreadStatus,
    description: 'Thread status (domain enum, not the response envelope code)',
  })
  status: UserMessageThreadStatus;

  @ApiProperty({ enum: MessageThreadType, description: 'Peer type P2P|GROUP' })
  toObjType: MessageThreadType;

  @ApiProperty({ example: 2, description: 'Peer id (userId or groupId)' })
  toObjId: number;

  @ApiProperty({ example: '', description: 'Friend-request message' })
  reqMessage: string;

  @ApiProperty({ example: 12, description: 'Underlying message thread id (nullable)' })
  threadId?: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  createdAt: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  updatedAt: number;

  @ApiProperty({ example: false })
  isDeleted: boolean;

  @ApiProperty({
    example: '9007199254740993',
    description: 'Read position (BigInt→string, nullable)',
  })
  lastRead?: string;

  // P2P items carry userItem: UserResponseDto; GROUP items carry groupItem: GroupResponseDto.
  @ApiProperty({ type: UserResponseDto, description: 'Peer user (for P2P)' })
  userItem?: UserResponseDto;

  @ApiProperty({ type: GroupResponseDto, description: 'Peer group (for GROUP)' })
  groupItem?: GroupResponseDto;
}

export class CreateGroupResponseDto {
  @ApiProperty({ example: 12, description: 'Group message thread id' })
  threadId: number;

  @ApiProperty({ example: 12, description: 'Group id' })
  groupId: number;
}
