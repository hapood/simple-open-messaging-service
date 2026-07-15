import { ApiProperty } from '@nestjs/swagger';
import {
  ContentType,
  GroupRole,
  MessageThreadType,
} from '../prisma/generated/client.js';
import { MEDIA_STATUS, MediaStatus } from '../common/media-status.js';

/**
 * Response entity DTOs (for OpenAPI response schemas). Field types reflect the on-the-wire serialized
 * result, uniformly applied by the global SerializeInterceptor (see src/common/serialize.interceptor.ts):
 * Date → millisecond timestamp (number); BigInt (e.g. an admin RefreshToken.id) → string. NOTE: Message.id
 * (BigInt global surrogate PK) is a cross-conversation throughput side-channel and is NEVER serialized —
 * messages carry only the per-thread Int `seq`. See MessageService.stripMessageId / the query `omit`s.
 *
 * Note on class definition order: a class referenced via @ApiProperty({ type: X }) must be declared
 * before the class that references it (property decorators are evaluated at class-declaration time; ES
 * classes are not hoisted — otherwise you hit the TDZ → runtime ReferenceError).
 */

export class UserResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'alice', description: 'Login unique name' })
  account!: string;

  @ApiProperty({ example: 'Alice', description: 'Display name' })
  name!: string;

  @ApiProperty({ example: 'https://.../a.webp', description: 'Avatar URL' })
  avatar!: string;

  @ApiProperty({
    example: 'Hey there! I am using SOMS.',
    description: 'Bio (about)',
  })
  bio!: string;

  @ApiProperty({ example: false, description: 'Whether an external user' })
  isForeigner!: boolean;

  @ApiProperty({ example: 'example.com', description: 'Domain (nullable)' })
  domain?: string;

  @ApiProperty({
    example: 1_700_000_000_000,
    description: 'Created at (ms timestamp)',
  })
  createdAt!: number;

  @ApiProperty({
    example: 1_700_000_000_000,
    description: 'Updated at (ms timestamp)',
  })
  updatedAt!: number;

  @ApiProperty({
    example: 3,
    description: 'Profile revision (name/avatar/bio). The federation + chat-open staleness cursor.',
  })
  profileRev!: number;

  @ApiProperty({ example: false })
  isDeleted!: boolean;

  // SELF-ONLY: whether the caller has unread friend requests. Populated solely by the self-profile
  // read; every other response builder must leave it unset so the badge never leaks to other clients.
  @ApiProperty({
    required: false,
    example: false,
    description: 'Unread friend-request badge (self only)',
  })
  hasUrFriendReq?: boolean;

  // SELF-ONLY: the caller's thread-list revision cursor (bumped on thread add/delete). Populated solely
  // by the self-profile read; every other response builder omits it.
  @ApiProperty({
    required: false,
    example: 5,
    description: 'Thread-list revision (self only — the thread-sync cursor)',
  })
  threadRevision?: number;

  // Note: hashPwd never appears in responses.
}

export class MessageResponseDto {
  @ApiProperty({
    example: 42,
    description:
      'Per-thread monotonic seq (0-indexed) — the message ordering key + identity. Allocated per-thread ' +
      '(NOT global): its deltas reveal only THIS thread volume, never server-wide throughput.',
  })
  seq!: number;

  @ApiProperty({ enum: ContentType, description: 'Content type' })
  contentType!: ContentType;

  @ApiProperty({ example: 'hello', description: 'Message content' })
  content!: string;

  @ApiProperty({ example: 12, description: 'Owning thread id' })
  threadId!: number;

  @ApiProperty({ example: 1, description: 'Sender userId' })
  creator!: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  createdAt!: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  updatedAt!: number;

  @ApiProperty({ example: false })
  isDeleted!: boolean;

  @ApiProperty({
    required: false,
    example: 'b3f4a1e2-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
    description:
      'Client-generated idempotency UUID (present when the message was sent through the optimistic-send path). The frontend correlates its optimistic bubble with this server-confirmed real by this key.',
  })
  clientMessageId?: string;

  @ApiProperty({
    required: false,
    enum: [MEDIA_STATUS.READY, MEDIA_STATUS.DOWNLOADING, MEDIA_STATUS.FAILED],
    example: MEDIA_STATUS.READY,
    description:
      "Federated media localize status (IMAGE/FILE/VIDEO/AUDIO only; absent = ready for non-media). " +
      "'ready' = bytes local + authz written (the URL serves 200); 'failed' = localize failed (URL 4xx, " +
      "retryable from the detail view); 'downloading' = localize in flight (carried only on a freshly-pulled " +
      "NEW_MESSAGE frame — the backend stores/pushes the 'ready'|'failed' terminals; the client infers " +
      "'downloading' optimistically on arrival / manual retry).",
  })
  mediaStatus?: MediaStatus;

  @ApiProperty({
    required: false,
    example: 42,
    description:
      "Monotonic status version — the client's reduceMediaStatus drops stale out-of-order MEDIA_STATUS " +
      'frames whose version is ≤ the already-applied one.',
  })
  sv?: number;
}

export class GroupResponseDto {
  @ApiProperty({ example: 12 })
  id!: number;

  @ApiProperty({ example: 'dev-team', description: 'Group name' })
  name!: string;

  @ApiProperty({ example: 1, description: 'Owner userId' })
  ownerId!: number;

  @ApiProperty({
    example: 'https://.../g.png',
    description: 'Group avatar URL',
  })
  avatar!: string;

  @ApiProperty({
    example: 'Frontend team sync',
    description: 'Group description / intro',
  })
  description!: string;

  @ApiProperty({
    example: 'soms.io',
    description:
      "The group's home (origin) domain. Empty for a locally-originated group (this server is the " +
      'origin); a peer domain for a federated mirror. Drives the federated-badge the way ' +
      'UserResponseDto.domain does for a P2P peer — empty self-hides the badge.',
  })
  domain!: string;

  @ApiProperty({ example: 12, description: 'Group message thread id' })
  threadId!: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  createdAt!: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  updatedAt!: number;
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
  id!: number;

  @ApiProperty({
    example: 12,
    description:
      'Conversation (MessageThread) id — the key for send-message / query-messages',
  })
  threadId!: number;

  @ApiProperty({ enum: MessageThreadType, description: 'Conversation type' })
  type!: MessageThreadType;

  @ApiProperty({
    example: 42,
    nullable: true,
    description: 'Last-read message seq (nullable)',
  })
  lastReadSeq?: number;

  @ApiProperty({
    enum: GroupRole,
    nullable: true,
    description: 'Member role for GROUP conversations; null for P2P',
  })
  role?: GroupRole | null;

  @ApiProperty({
    example: 3,
    description:
      'Unread message count for the caller (messages newer than their lastReadSeq). 0 when caught up.',
  })
  unreadCount!: number;

  @ApiProperty({
    type: Number,
    example: 1_700_000_000_000,
    nullable: true,
    description:
      'When the last message was sent (ms timestamp). Null on empty threads.',
  })
  lastMessageAt?: number | null;

  @ApiProperty({
    example: false,
    description:
      'Whether the caller has muted this conversation (notification channels — push + notif snapshot — are suppressed; in-app delivery is not).',
  })
  muted!: boolean;

  @ApiProperty({
    example: false,
    description:
      'Whether the caller has pinned this conversation to the top of their list.',
  })
  pinned!: boolean;

  @ApiProperty({
    type: Number,
    example: 1_700_000_000_000,
    nullable: true,
    description:
      'Most-recently-pinned timestamp (ms). Drives pinned-tier ordering (desc). Null when not pinned.',
  })
  pinnedAt?: number | null;

  @ApiProperty({
    type: Number,
    example: 1_700_000_000_000,
    nullable: true,
    description:
      'Per-user "clear chat history" watermark (ms). query-messages hides rows older than this for THIS user only; the peer copy is untouched. Null when history has not been cleared.',
  })
  clearedAt?: number | null;

  @ApiProperty({
    required: false,
    example: false,
    description:
      'Whether the caller has blocked the peer (P2P conversations only). Absent on GROUP. Drives the Block ↔ Unblock label + the blocked banner.',
  })
  blocked?: boolean;

  @ApiProperty({
    type: String,
    required: false,
    example: 'Alice (work)',
    nullable: true,
    description:
      "Per-user alias/remark. Overrides peer.account (P2P) / group.name (GROUP) in the CALLER's chat header + list. Null when not set (real name used).",
  })
  alias?: string | null;

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
 * One entry of the create/invite `skipped` list — a friend who could not be invited (not a friend,
 * no P2P thread, or the invite write failed). Mirrors the group/invite response shape.
 */
export class SkippedInviteDto {
  @ApiProperty({ example: 7 })
  userId!: number;

  @ApiProperty({ example: 'not a friend or no conversation' })
  reason!: string;
}

export class CreateGroupResponseDto {
  @ApiProperty({ example: 12, description: 'Group message thread id' })
  threadId!: number;

  @ApiProperty({ example: 12, description: 'Group id' })
  groupId!: number;

  /** Friend user ids who were successfully sent a GROUP_INVITE at creation. */
  @ApiProperty({ type: [Number], example: [3, 7] })
  invited!: number[];

  /** Friends who could not be invited (not a friend / no P2P thread / write failure). */
  @ApiProperty({ type: SkippedInviteDto, isArray: true })
  skipped!: SkippedInviteDto[];
}

/**
 * One row of a group roster (group/members). The caller's own row carries their role so the
 * client can show role-gated actions; isOwner is derived from the group's ownerId rather than
 * carried on the participant (the participant role is the source of truth, ownerId is a
 * denormalized O(1) pointer kept in sync on transfer).
 */
export class GroupMemberDto {
  @ApiProperty({ example: 7 })
  userId!: number;

  @ApiProperty({ example: 'alice', description: 'Login unique name' })
  account!: string;

  @ApiProperty({ example: 'Alice', description: 'Display name' })
  name!: string;

  @ApiProperty({ example: 'https://.../a.webp', description: 'Avatar URL' })
  avatar!: string;

  @ApiProperty({ example: false, description: 'Whether this member is an external (federated) user' })
  isForeigner!: boolean;

  @ApiProperty({ example: 'example.com', description: 'Domain (empty for a local member)' })
  domain!: string;

  @ApiProperty({ enum: GroupRole, description: 'Member role in this group' })
  role!: GroupRole;

  @ApiProperty({
    example: 1_700_000_000_000,
    description: 'Joined at (ms timestamp)',
  })
  joinedAt!: number;

  @ApiProperty({
    example: false,
    description: 'Whether this member is the group owner',
  })
  isOwner!: boolean;
}
