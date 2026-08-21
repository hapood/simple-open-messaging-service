import { ApiProperty } from '@nestjs/swagger';
import {
  ContentType,
  GroupRole,
  MessageThreadType,
} from '../database/enums.js';
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
    example: 31,
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
    description:
      'Profile revision (name/avatar/bio). The federation + chat-open staleness cursor.',
  })
  profileRev!: number;

  @ApiProperty({ example: false })
  isDeleted!: boolean;

  // Note: hashPwd never appears in responses. threadRevision is NOT here either — it is pushed via the
  // SSE HELLO connect handshake (the threadlist's sole delta-replay cursor), never the profile response.
  // Friend-request notification state is delivered through the unified state delta; its seen cursor is
  // device-local and never appears in an API response.
}

/** Server-authoritative read state returned after committing a viewport read HWM. */
export class ThreadReadStateDto {
  @ApiProperty({ example: 12, description: 'Conversation id' })
  threadId!: number;

  @ApiProperty({
    example: 42,
    description: 'Server-confirmed monotonic read HWM',
  })
  lastReadSeq!: number;

  @ApiProperty({
    example: 3,
    maximum: 1000,
    description:
      'Unread count; 1000 means 1000 or more and is rendered as 999+.',
  })
  unreadCount!: number;

  @ApiProperty({
    type: [String],
    enum: ['all', 'me'],
    example: ['all', 'me'],
    description:
      'Distinct semantic mention kinds in the same bounded unread sample.',
  })
  mentionUnread!: Array<'all' | 'me'>;
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
      'Federated media localize status (IMAGE/FILE/VIDEO/AUDIO only; absent = ready for non-media). ' +
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

  @ApiProperty({
    example: '!01JABCDEFGHJKMNPQRSTVWXYZ',
    description:
      'Globally stable group account used to identify the group across servers',
  })
  account!: string;

  @ApiProperty({ example: 'dev-team', description: 'Group name' })
  name!: string;

  @ApiProperty({ example: 1, description: 'Owner userId' })
  ownerId!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: null,
    description: 'Terminal dissolution timestamp; history remains readable',
  })
  dissolvedAt!: number | null;

  @ApiProperty({
    example: 'https://.../g.png',
    description: 'Group avatar URL',
  })
  avatar!: string;

  @ApiProperty({
    example: 7,
    description: 'Monotonic group identity revision (name/avatar/description).',
  })
  profileRev!: number;

  @ApiProperty({
    example: 'Frontend team sync',
    description: 'Group description / intro',
  })
  description!: string;

  @ApiProperty({
    example: true,
    description: 'Whether ordinary members may invite users to this group',
  })
  membersCanInvite!: boolean;

  @ApiProperty({
    example: 'soms.io',
    description:
      "The group's home (origin) domain. Empty for a locally-originated group (this server is the " +
      'origin); a peer domain for a federated mirror.',
  })
  domain!: string;

  @ApiProperty({ example: 12, description: 'Group message thread id' })
  threadId!: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  createdAt!: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  updatedAt!: number;

  @ApiProperty({ type: () => [GroupMemberRefDto] })
  members!: GroupMemberRefDto[];
}

/** Membership/role facts carried by the authoritative conversation snapshot.
 * Display metadata is resolved from PROFILE or source-scoped MEMBER_PROFILE state. */
export class GroupMemberRefDto {
  @ApiProperty({ example: 7 })
  userId!: number;

  @ApiProperty({ example: 'alice' })
  account!: string;

  @ApiProperty({ example: 'example.com' })
  domain!: string;

  @ApiProperty({ example: 'group-origin.example' })
  profileSourceDomain!: string;

  @ApiProperty({ enum: GroupRole })
  role!: GroupRole;

  @ApiProperty({ example: 1_700_000_000_000 })
  joinedAt!: number;

  @ApiProperty({ example: false })
  isOwner!: boolean;
}

/**
 * A user's view of one conversation (their ThreadParticipant row), hydrated with the peer entity.
 * The threadId is the conversation handle — the key clients use for send-message / query-messages.
 * Replaces the overloaded UserMessageThreadResponseDto: friendship state no longer lives here.
 */
export class ConversationItemDto {
  @ApiProperty({
    enum: ['ACTIVE', 'READ_ONLY'],
    description:
      'Rendered state for a visible conversation. Hidden/deleted rows are not returned.',
  })
  conversationState!: 'ACTIVE' | 'READ_ONLY';

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
    enum: GroupRole,
    nullable: true,
    description: 'Member role for GROUP conversations; null for P2P',
  })
  role?: GroupRole | null;

  @ApiProperty({
    type: Number,
    example: 1_700_000_000_000,
    nullable: true,
    description:
      'When the last message was sent (ms timestamp). Null on empty threads.',
  })
  lastMessageAt?: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Per-thread seq of the newest message (the denormalized MessageThread.lastMessageSeq). Null on empty ' +
      'threads. The client passes this as the mark-read `lastReadSeq` when opening a conversation (mark all ' +
      'current up to this seq) — so mark-read ALWAYS carries a seq, never the no-seq "mark all" mode.',
  })
  lastMessageSeq?: number | null;

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
    example: 31,
    nullable: true,
    description:
      'Per-user "clear chat history" sequence watermark. Messages at or below it are hidden for THIS user only; the peer copy is untouched. Null when history has not been cleared.',
  })
  clearedSeq?: number | null;

  @ApiProperty({
    required: false,
    example: false,
    description:
      'Whether the caller blocks new messages from this conversation. Applies to P2P and GROUP.',
  })
  blocked?: boolean;

  @ApiProperty({
    required: false,
    example: true,
    description:
      'Whether the P2P friendship is active. False keeps the historical conversation readable but read-only; absent on GROUP.',
  })
  friendshipActive?: boolean;

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

export class CreateGroupResponseDto {
  @ApiProperty({ example: 12, description: 'Group message thread id' })
  threadId!: number;

  @ApiProperty({ example: 12, description: 'Group id' })
  groupId!: number;
}
