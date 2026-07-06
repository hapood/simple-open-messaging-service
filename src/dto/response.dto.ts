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

  @ApiProperty({
    required: false,
    example: 'b3f4a1e2-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
    description:
      'Client-generated idempotency UUID (present when the message was sent through the optimistic-send path). The frontend correlates its optimistic bubble with this server-confirmed real by this key.',
  })
  clientMessageId?: string;
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
    example: 3,
    description:
      'Unread message count for the caller (messages newer than their lastReadMsgId). 0 when caught up.',
  })
  unreadCount: number;

  @ApiProperty({
    example: 'hi group',
    nullable: true,
    description:
      'Short preview of the thread\'s last message (content-type aware: "[Photo]" / "[Group invite]" / text). Null on empty threads.',
  })
  lastMessagePreview?: string | null;

  @ApiProperty({
    example: 1_700_000_000_000,
    nullable: true,
    description: 'When the last message was sent (ms timestamp). Null on empty threads.',
  })
  lastMessageAt?: number | null;

  @ApiProperty({
    example: 7,
    nullable: true,
    description: 'Sender userId of the last message. Null on empty threads.',
  })
  lastMessageSenderId?: number | null;

  @ApiProperty({
    example: 'Alice',
    nullable: true,
    description:
      'Display name of the last-message sender (GROUP conversations only — used to prefix group previews like "Alice: hi"). Null/absent on P2P and empty threads.',
  })
  lastMessageSenderName?: string | null;

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

/**
 * One entry of the create/invite `skipped` list — a friend who could not be invited (not a friend,
 * no P2P thread, or the invite write failed). Mirrors the group/invite response shape.
 */
export class SkippedInviteDto {
  @ApiProperty({ example: 7 })
  userId: number;

  @ApiProperty({ example: 'not a friend or no conversation' })
  reason: string;
}

export class CreateGroupResponseDto {
  @ApiProperty({ example: 12, description: 'Group message thread id' })
  threadId: number;

  @ApiProperty({ example: 12, description: 'Group id' })
  groupId: number;

  /** Friend user ids who were successfully sent a GROUP_INVITE at creation. */
  @ApiProperty({ type: [Number], example: [3, 7] })
  invited: number[];

  /** Friends who could not be invited (not a friend / no P2P thread / write failure). */
  @ApiProperty({ type: SkippedInviteDto, isArray: true })
  skipped: SkippedInviteDto[];
}

/**
 * One row of a group roster (group/members). The caller's own row carries their role so the
 * client can show role-gated actions; isOwner is derived from the group's ownerId rather than
 * carried on the participant (the participant role is the source of truth, ownerId is a
 * denormalized O(1) pointer kept in sync on transfer).
 */
export class GroupMemberDto {
  @ApiProperty({ example: 7 })
  userId: number;

  @ApiProperty({ example: 'alice', description: 'Login unique name' })
  uniqName: string;

  @ApiProperty({ example: 'Alice', description: 'Display name' })
  name: string;

  @ApiProperty({ example: 'https://.../a.webp', description: 'Avatar URL' })
  avatar: string;

  @ApiProperty({ enum: GroupRole, description: 'Member role in this group' })
  role: GroupRole;

  @ApiProperty({ example: 1_700_000_000_000, description: 'Joined at (ms timestamp)' })
  joinedAt: number;

  @ApiProperty({ example: false, description: 'Whether this member is the group owner' })
  isOwner: boolean;
}
