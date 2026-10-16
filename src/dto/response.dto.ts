import {
  ApiProperty,
  ApiExtraModels,
  PickType,
  getSchemaPath,
} from '@nestjs/swagger';
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
    example: 7,
    description: 'Identity namespace; 0 for identities created on this server',
  })
  namespaceId!: number;

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

export class ThreadFeedPreviewDto {
  @ApiProperty() seq!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({
    type: 'object',
    properties: {
      account: { type: 'string' },
      profileNamespaceId: { type: 'number' },
      profileRev: { type: 'number' },
    },
    required: ['account', 'profileNamespaceId', 'profileRev'],
  })
  sender!: {
    account: string;
    profileNamespaceId: number;
    profileRev: number;
  };
  @ApiProperty({ enum: ['LIVE', 'USER_RETRACTION', 'MODERATION_REMOVAL'] })
  status!: 'LIVE' | 'USER_RETRACTION' | 'MODERATION_REMOVAL';
  @ApiProperty({ required: false }) text?: string;
}

/** Committed private label and its account-scoped feed coordinate. */
export class ThreadAliasResultDto {
  @ApiProperty() threadId!: number;
  @ApiProperty() threadFeedId!: number;
  @ApiProperty({ type: String, nullable: true }) alias!: string | null;
}

/** Exact counterpart or group identity resolved from the established relationship. */
export class ThreadFeedProfileDto {
  @ApiProperty() account!: string;
}

/** Complete server thread snapshot; structure and attention share one feed coordinate. */
export class ThreadFeedStateDto {
  @ApiProperty({ enum: ['P2P', 'GROUP'] }) type!: 'P2P' | 'GROUP';
  @ApiProperty({ minimum: 0 }) publisherNamespaceId!: number;
  @ApiProperty({
    type: Number,
    minimum: 0,
    nullable: true,
    description:
      'Viewer home namespace in the group origin space; null for P2P or unknown binding',
  })
  selfMentionNamespaceId!: number | null;
  @ApiProperty({ enum: ['ACTIVE', 'READ_ONLY'] }) conversationState!:
    | 'ACTIVE'
    | 'READ_ONLY';
  @ApiProperty() blocked!: boolean;
  @ApiProperty({ enum: ['OWNER', 'ADMIN', 'MEMBER'], nullable: true })
  role!: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  @ApiProperty() profileAccount!: string;
  @ApiProperty({ minimum: 0 }) profileRev!: number;
  @ApiProperty({ type: String, nullable: true }) alias!: string | null;
  @ApiProperty({ type: [ThreadFeedPreviewDto], required: false })
  previews?: ThreadFeedPreviewDto[];
  @ApiProperty({ example: 12, minimum: 1, maximum: 2147483647 })
  threadFeedId!: number;
  @ApiProperty({ example: 12, description: 'Conversation id' })
  threadId!: number;

  @ApiProperty({ minimum: 0 }) messageEndSeq!: number;
  @ApiProperty({ minimum: 0 }) tombstoneEndSeq!: number;
  @ApiProperty({ type: String, nullable: true, example: '42' })
  groupMetaFeedEndId!: string | null;

  @ApiProperty({ minimum: 0 })
  joinRequestEndFeedId!: number;

  @ApiProperty({ minimum: -1 })
  joinRequestReadFeedId!: number;

  @ApiProperty({ minimum: 0 })
  groupInviteEndFeedId!: number;

  @ApiProperty({
    example: 42,
    description:
      'Server-confirmed read position; explicit force may move it backwards',
  })
  lastReadSeq!: number;

  @ApiProperty({
    minimum: 0,
    description: 'Highest displayed group announcement feed coordinate',
  })
  announcementReadFeedId!: number;

  @ApiProperty({
    example: 3,
    minimum: 0,
    description: 'Exact persisted unread count',
  })
  unreadCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Latest projected surviving mention seq; clients decide whether to display attention',
  })
  lastMentionSeq!: number | null;
}

export class ThreadFeedPageDto {
  @ApiProperty() threadFeedEndId!: number;
  @ApiProperty() through!: number;
  @ApiProperty() scannedThrough!: number;
  @ApiProperty() hasMore!: boolean;
  @ApiProperty({ type: [ThreadFeedStateDto] })
  items!: ThreadFeedStateDto[];
}

export class MessageAuthorAddressResponseDto {
  @ApiProperty({ example: 'alice' })
  account!: string;

  @ApiProperty({ example: 7 })
  namespaceId!: number;
}

export class MessageResponseDto {
  @ApiProperty({
    example: 0,
    description: 'Namespace of the message author identity.',
  })
  namespaceId!: number;

  @ApiProperty({
    example: 42,
    description:
      'Per-thread local sequence. This is the client cache and timeline coordinate.',
  })
  seq!: number;

  @ApiProperty({
    example: 42,
    nullable: true,
    type: Number,
    description:
      'Origin sequence in publisherNamespaceId. Null for messages authored locally and not yet assigned an upstream origin.',
  })
  originSeq!: number | null;

  @ApiProperty({ minimum: 0, description: 'Namespace owning originSeq.' })
  publisherNamespaceId!: number;

  @ApiProperty({
    minimum: 0,
    description:
      'Author profile namespace in the publisher server’s space, preserved independently of the projected author identity.',
  })
  profileNamespaceId!: number;

  @ApiProperty({
    example: 7,
    description:
      'Immutable complete-profile revision selected when this message was authored',
  })
  profileRev!: number;

  @ApiProperty({ enum: ContentType, description: 'Content type' })
  contentType!: ContentType;

  @ApiProperty({ example: 'hello', description: 'Message content' })
  content!: string;

  @ApiProperty({ example: 12, description: 'Owning thread id' })
  threadId!: number;

  @ApiProperty({
    type: MessageAuthorAddressResponseDto,
    example: { account: 'alice', namespaceId: 0 },
    description:
      'Sender address snapshot; SYSTEM notifications use $system at namespace 0.',
  })
  creator!: MessageAuthorAddressResponseDto;

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
      'Local materialization state. STUB and FAILED remain client-visible message slots independent of download completion.',
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

export class MessageTombResponseDto extends PickType(MessageResponseDto, [
  'threadId',
  'seq',
  'creator',
  'profileRev',
  'createdAt',
  'updatedAt',
] as const) {
  @ApiProperty({ enum: ['TOMB'] })
  contentType!: 'TOMB';

  @ApiProperty({ type: Boolean, enum: [true] })
  isDeleted!: true;

  @ApiProperty({ enum: MessageDeleteType })
  deletionType!: MessageDeleteType;
}

@ApiExtraModels(MessageResponseDto, MessageTombResponseDto)
export class MessageQueryPageDto {
  @ApiProperty({
    type: 'array',
    items: {
      oneOf: [
        { $ref: getSchemaPath(MessageResponseDto) },
        { $ref: getSchemaPath(MessageTombResponseDto) },
      ],
    },
  })
  messages!: Array<MessageResponseDto | MessageTombResponseDto>;

  @ApiProperty({ type: Number, nullable: true })
  resolvedAnchorSeq!: number | null;

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

export class ThreadReadPositionResultDto {
  @ApiProperty({ enum: ['APPLIED', 'REJECTED'], example: 'APPLIED' })
  status!: 'APPLIED' | 'REJECTED';

  @ApiProperty({ required: false, example: 'THREAD_NOT_FOUND' })
  reason?: string;

  @ApiProperty({ required: false, example: 42 })
  lastReadSeq?: number;
}

/**
 * A user's view of one conversation (their AccountThreadState row), hydrated with the peer entity.
 * The threadId is the conversation handle — the key clients use for send-message / query-messages.
 * Replaces the overloaded UserMessageThreadResponseDto: friendship state no longer lives here.
 */
export class CreateGroupResponseDto {
  @ApiProperty({ example: 12, description: 'Group message thread id' })
  threadId!: number;

  @ApiProperty({ example: 12, description: 'Group id' })
  groupId!: number;
}
