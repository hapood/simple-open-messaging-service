import { ApiProperty } from '@nestjs/swagger';
import {
  ContentType,
  FriendshipStatus,
  GroupRole,
  MessageThreadType,
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

  @ApiProperty({
    example: 'Hey there! I am using SOMS.',
    description: 'Bio (about)',
  })
  bio: string;
}

export class UserNotiBoxResponseDto {
  @ApiProperty({
    example: false,
    description: 'Whether there are unread friend requests',
  })
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

  @ApiProperty({
    example: 1_700_000_000_000,
    description: 'Created at (ms timestamp)',
  })
  createdAt: number;

  @ApiProperty({
    example: 1_700_000_000_000,
    description: 'Updated at (ms timestamp)',
  })
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
  @ApiProperty({
    example: '9007199254740993',
    description: 'Message id (BigInt→string)',
  })
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

  @ApiProperty({
    example: 'https://.../g.png',
    description: 'Group avatar URL',
  })
  avatar: string;

  @ApiProperty({ example: 12, description: 'Group message thread id' })
  threadId: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  createdAt: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  updatedAt: number;
}

/**
 * A user's view of one conversation (their ThreadParticipant row), hydrated with the peer entity.
 * The threadId is the conversation handle — the key clients use for send-message / query-messages.
 * Replaces the overloaded UserMessageThreadResponseDto: friendship state no longer lives here.
 */
export class ConversationItemDto {
  @ApiProperty({
    example: 1,
    description: "This user's ThreadParticipant row id",
  })
  id: number;

  @ApiProperty({
    example: 12,
    description:
      'Conversation (MessageThread) id — the key for send-message / query-messages',
  })
  threadId: number;

  @ApiProperty({ enum: MessageThreadType, description: 'Conversation type' })
  type: MessageThreadType;

  @ApiProperty({
    example: '9007199254740993',
    description: 'Last-read message id (BigInt→string, nullable)',
  })
  lastReadMsgId?: string;

  @ApiProperty({
    enum: GroupRole,
    nullable: true,
    description: 'Member role for GROUP conversations; null for P2P',
  })
  role?: GroupRole | null;

  @ApiProperty({
    type: UserResponseDto,
    description: 'Peer user (P2P conversations only)',
  })
  peerUser?: UserResponseDto;

  @ApiProperty({
    type: GroupResponseDto,
    description: 'Group (GROUP conversations only)',
  })
  group?: GroupResponseDto;
}

/**
 * A P2P relationship / friend request. One row per unordered user pair; direction is carried by
 * requesterId. Returned by the friend-request endpoints and by thread/by-user-id.
 */
export class FriendshipDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 2, description: 'One side of the pair (min userId)' })
  userAId: number;

  @ApiProperty({
    example: 3,
    description: 'Other side of the pair (max userId)',
  })
  userBId: number;

  @ApiProperty({
    example: 2,
    description: 'The user who initiated the request',
  })
  requesterId: number;

  @ApiProperty({
    enum: FriendshipStatus,
    description: 'PENDING | APPROVED | BLOCKED | DELETED',
  })
  status: FriendshipStatus;

  @ApiProperty({
    example: 12,
    required: false,
    description: 'The P2P MessageThread id (set once APPROVED)',
  })
  threadId?: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  createdAt: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  updatedAt: number;
}

export class CreateGroupResponseDto {
  @ApiProperty({ example: 12, description: 'Group message thread id' })
  threadId: number;

  @ApiProperty({ example: 12, description: 'Group id' })
  groupId: number;
}
