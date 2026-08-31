import { ApiProperty } from '@nestjs/swagger';
import { ContentType, MessageDeleteType } from '../database/enums.js';
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

  @ApiProperty({
    example: false,
    description: 'Whether this identity is a group',
  })
  isGroup!: boolean;

  @ApiProperty({
    example: 'example.com',
    description: 'Canonical identity domain; local users use local',
  })
  domain!: string;

  @ApiProperty({
    example: 7,
    description: 'Identity namespace; 0 for identities created on this server',
  })
  namespaceId!: number;

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

  // Note: hashPwd never appears in responses. The state-feed cursor is delivered by the
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

export class MessageAuthorAddressResponseDto {
  @ApiProperty({ example: 'alice' })
  account!: string;

  @ApiProperty({ example: 'local' })
  domain!: string;

  @ApiProperty({ example: 7 })
  namespaceId!: number;
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

  @ApiProperty({
    type: MessageAuthorAddressResponseDto,
    example: { account: 'alice', domain: 'local' },
    nullable: true,
    description:
      'Sender address snapshot; null for server-authored SYSTEM messages',
  })
  creator!: MessageAuthorAddressResponseDto | null;

  @ApiProperty({ example: 1_700_000_000_000 })
  createdAt!: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  updatedAt!: number;

  @ApiProperty({ example: false })
  isDeleted!: boolean;

  @ApiProperty({
    enum: ['STUB', 'FAILED', 'READY'],
    example: 'READY',
    description:
      'Local materialization state. STUB and FAILED remain client-visible placeholders; only READY participates in derived projections.',
  })
  localState!: 'STUB' | 'FAILED' | 'READY';

  @ApiProperty({
    required: false,
    example: 'b3f4a1e2-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
    description:
      'Client-generated idempotency UUID (present when the message was sent through the optimistic-send path). The frontend correlates its optimistic bubble with this server-confirmed real by this key.',
  })
  clientMessageId?: string;

  @ApiProperty({
    required: false,
    enum: [
      MEDIA_STATUS.READY,
      MEDIA_STATUS.PENDING,
      MEDIA_STATUS.DOWNLOADING,
      MEDIA_STATUS.FAILED,
    ],
    example: MEDIA_STATUS.READY,
    description:
      'Federated media localize status (IMAGE/FILE/VIDEO/AUDIO only; absent = ready for non-media). ' +
      "'ready' = the Message is READY and every referenced blob is local; 'failed' = the Message is a " +
      "FAILED placeholder; 'pending'/'downloading' = the Message is a STUB placeholder.",
  })
  mediaStatus?: MediaStatus;
}

export class MessageQueryPageDto {
  @ApiProperty({ type: [MessageResponseDto] })
  messages!: MessageResponseDto[];

  @ApiProperty({ type: () => [MessageHistoryGapDto] })
  gaps!: MessageHistoryGapDto[];

  @ApiProperty({ example: 42, description: 'Direction-relative scan cursor' })
  scannedThrough!: number;

  @ApiProperty({ example: false })
  hasMore!: boolean;
}

export class MessageHistoryGapDto {
  @ApiProperty({ example: 20, description: 'First missing message sequence' })
  startSeq!: number;

  @ApiProperty({ example: 30, description: 'Last missing message sequence' })
  endSeq!: number;

  @ApiProperty({ example: true })
  recoverable!: boolean;
}

export class MessageTombstoneResponseDto {
  @ApiProperty({ example: 42, description: 'Thread-local deletion coordinate' })
  deletionSeq!: number;

  @ApiProperty({ example: 12, description: 'Owning conversation id' })
  threadId!: number;

  @ApiProperty({ example: 31, description: 'Deleted message sequence' })
  messageSeq!: number;

  @ApiProperty({ enum: MessageDeleteType })
  type!: MessageDeleteType;

  @ApiProperty({ example: 1_700_000_000_000 })
  createdAt!: number;

  @ApiProperty({ example: 1_700_000_000_000 })
  updatedAt!: number;
}

export class MessageTombstoneQueryPageDto {
  @ApiProperty({ type: [MessageTombstoneResponseDto] })
  tombstones!: MessageTombstoneResponseDto[];

  @ApiProperty({ example: 42, description: 'Direction-relative scan cursor' })
  scannedThrough!: number;

  @ApiProperty({ example: false })
  hasMore!: boolean;
}

/**
 * A user's view of one conversation (their ThreadParticipant row), hydrated with the peer entity.
 * The threadId is the conversation handle — the key clients use for send-message / query-messages.
 * Replaces the overloaded UserMessageThreadResponseDto: friendship state no longer lives here.
 */
export class CreateGroupResponseDto {
  @ApiProperty({ example: 12, description: 'Group message thread id' })
  threadId!: number;

  @ApiProperty({ example: 12, description: 'Group id' })
  groupId!: number;
}
