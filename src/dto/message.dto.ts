import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ContentType } from '../database/enums.js';
import { THREAD_PREVIEW_LIMIT } from '../message/thread-preview-limit.js';

/** Message-domain request DTOs. Validation rules are ported from the original message.controller inline types. */

export class SendMessageDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({
    example: '{"text":"hello","quote":{"seq":31}}',
    description:
      'Message content. PURE_TEXT uses a JSON envelope with text and an optional quote seq.',
  })
  @IsString()
  @IsNotEmpty()
  // JSON escaping can expand a 4,000-code-point text body substantially; the controller validates
  // the decoded `text` field against the product limit.
  @MaxLength(32000, { message: 'content envelope is too large' })
  content!: string;

  // Direct-send content types ONLY. Media is committed exclusively by the staged
  // /send-media + /upload* promotion flow; the other schema values are server-side.
  // LINK is client-authorable too: `content` carries an owned, completed generationId. The server
  // consumes the in-memory result, so clients cannot forge card metadata or CAS asset references.
  @ApiProperty({
    enum: ['PURE_TEXT', 'LINK'],
    required: false,
    description:
      'Direct-send content type (defaults to PURE_TEXT). Media uses /send-media + /upload*.',
  })
  @IsOptional()
  @IsIn(['PURE_TEXT', 'LINK'])
  contentType?: ContentType;

  @ApiPropertyOptional({
    example: 31,
    description: 'Local sequence of the message being quoted.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quoteTargetSeq?: number;

  @ApiProperty({
    required: false,
    example: 'b3f4a1e2-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
    description:
      'Client-generated UUID for send idempotency. Retrying a send with the same clientMessageId returns the original Message instead of creating a duplicate. Omit when retry identity is not required.',
  })
  @IsOptional()
  @IsUUID()
  clientMessageId?: string;

  @ApiProperty({
    required: false,
    description:
      'Keep a completed LINK generation available for another selected destination. The final send must omit this flag.',
  })
  @IsOptional()
  @IsBoolean()
  retainLinkGeneration?: boolean;
}

export class ContactCardTargetDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  account!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  namespaceId!: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  profileRev!: number;
}

export class SendContactCardDto {
  @ApiProperty({ example: 12, description: 'Destination conversation id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({ type: ContactCardTargetDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ContactCardTargetDto)
  target!: ContactCardTargetDto;

  @ApiPropertyOptional({
    example: 31,
    description: 'Local sequence of the message being quoted.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quoteTargetSeq?: number;

  @ApiProperty({ description: 'Client send-idempotency UUID' })
  @IsUUID()
  clientMessageId!: string;
}

export class ForwardSourceMessageDto {
  @ApiProperty({ example: 8, description: 'Source conversation id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({
    example: 31,
    description: 'Source message seq within the conversation',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seq!: number;
}

export class QueryDeletedMessagesDto {
  @ApiProperty({ example: 12, description: 'Conversation id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiPropertyOptional({
    example: 120,
    description:
      'Optional recovery filter. Tombstones above this target message sequence are scanned but omitted.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  maxMessageSeq?: number;

  @ApiPropertyOptional({
    example: 0,
    description: 'Exclusive forward tombstone cursor.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  after?: number;

  @ApiPropertyOptional({
    example: 101,
    description: 'Exclusive reverse tombstone cursor.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  before?: number;

  @ApiPropertyOptional({
    example: 20,
    description: 'Inclusive boundary at the opposite end of the query.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  through?: number;

  @ApiPropertyOptional({ default: 100, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}

export class WithdrawMessageDto {
  @ApiProperty({ example: 12, description: 'Conversation id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({ example: 31, description: 'Local message seq' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seq!: number;
}

export const ForwardMode = {
  DIRECT: 'DIRECT',
  HISTORY: 'HISTORY',
} as const;
export type ForwardMode = (typeof ForwardMode)[keyof typeof ForwardMode];

/** Re-send one visible message directly, or snapshot a selection into a FORWARD card. */
export class SendForwardDto {
  @ApiProperty({ example: 12, description: 'Destination conversation id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({ type: ForwardSourceMessageDto, isArray: true })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ForwardSourceMessageDto)
  sourceMessages!: ForwardSourceMessageDto[];

  @ApiProperty({
    enum: Object.values(ForwardMode),
    description:
      'DIRECT re-sends exactly one message as the caller; HISTORY creates a chat-record bundle.',
  })
  @IsIn(Object.values(ForwardMode))
  mode!: ForwardMode;

  @ApiPropertyOptional({
    example: 31,
    description: 'Local sequence of the message being quoted.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quoteTargetSeq?: number;

  @ApiProperty({ description: 'Client send-idempotency UUID' })
  @IsUUID()
  clientMessageId!: string;
}

/**
 * Stage a media send BEFORE the upload: the server creates a PendingMedia(pending) row carrying
 * clientMessageId (+ optional display meta) so a crash between staging and upload leaves an
 * attributable record. No Message or seq is created yet — the upload route promotes the stage to a
 * real Message once the bytes land. Reusing the id is idempotent unless retry=true explicitly moves
 * a failed stage back to pending.
 */
export class SendMediaDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({
    enum: ['IMAGE', 'FILE', 'VIDEO', 'AUDIO', 'GALLERY'],
    description:
      'Media content type being staged (PURE_TEXT uses /send-message directly). GALLERY is a multi-asset bundle of N files.',
  })
  @IsIn(['IMAGE', 'FILE', 'VIDEO', 'AUDIO', 'GALLERY'])
  contentType!: ContentType;

  @ApiProperty({
    description:
      'Client-generated UUID identifying this staged send. The same value is sent on the subsequent upload to promote it; retrying the stage is idempotent.',
  })
  @IsUUID()
  clientMessageId!: string;

  @ApiPropertyOptional({
    example: 31,
    description: 'Local sequence of the message being quoted.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quoteTargetSeq?: number;

  @ApiProperty({
    required: false,
    default: 1,
    description:
      'Number of files in this batch. 1 for single-file types (the default); N (≤10) for GALLERY. Each file is uploaded separately sharing the same clientMessageId; the Nth upload promotes the batch.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  fileCnt?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Explicit retry. When true, an existing failed stage owned by this user is moved back to pending.',
  })
  @IsOptional()
  @IsBoolean()
  retry?: boolean;
}

/** Query the caller's uncommitted local media sends in one conversation. */
export class QueryMediaStagesDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;
}

export class QueryMessagesDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiPropertyOptional({
    example: 42,
    description: 'Exclusive forward message-sequence cursor.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  after?: number;

  @ApiPropertyOptional({
    example: 101,
    description: 'Exclusive reverse message-sequence cursor.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  before?: number;

  @ApiPropertyOptional({
    example: 80,
    description:
      'Inclusive fixed boundary at the opposite end of the selected direction.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  through?: number;

  @ApiPropertyOptional({
    example: 7,
    description:
      'Origin anchor namespace. When supplied with originSeq, the server resolves it to the local thread seq before reading history.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  anchorNamespaceId?: number;

  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Local anchor sequence. Cannot be combined with origin anchor or pagination cursors.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  anchorSeq?: number;

  @ApiPropertyOptional({
    example: 42,
    description:
      'Origin anchor sequence in anchorNamespaceId. Requires anchorNamespaceId and cannot be combined with after/before.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  anchorOriginSeq?: number;

  @ApiPropertyOptional({
    type: Number,
    example: 20,
    default: 20,
    description: 'Suggested page size (1-50).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50, { message: 'take must be at most 50' })
  take?: number;
}

/** Commit the viewport-dwelled local read HWM. The server merges it monotonically with its cursor. */
export class MarkReadDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({
    example: 42,
    description: 'Highest message seq the viewport has confirmed read locally.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  localReadHwm!: number;

  @ApiPropertyOptional({
    default: false,
    description: 'Explicitly allow the read position to move backwards.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/** Pull complete thread snapshots in a bounded account feed range. */
export class ThreadFeedQueryDto {
  @ApiPropertyOptional({
    default: 0,
    minimum: 0,
    maximum: THREAD_PREVIEW_LIMIT,
    description: 'Number of memory previews, up to 3.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(THREAD_PREVIEW_LIMIT)
  previewCount?: number;

  @ApiProperty({ example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  after!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  through?: number;

  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}

/** Toggle mute for a conversation (the caller's AccountThreadState row). */
export class SetMutedDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({
    example: true,
    description: 'true = mute (suppress notifications), false = unmute',
  })
  @IsBoolean()
  muted!: boolean;
}

/** Suppress/resume live delivery for one conversation while retaining its history. */
export class SetBlockedDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({
    example: true,
    description: 'true = block new messages, false = resume delivery',
  })
  @IsBoolean()
  blocked!: boolean;
}

/** Toggle pin for a conversation (the caller's AccountThreadState row). */
export class SetPinnedDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({
    example: true,
    description: 'true = pin to top, false = unpin',
  })
  @IsBoolean()
  pinned!: boolean;
}

/** Set a per-user alias/remark for a conversation — a nickname that overrides the peer's handle
 *  (P2P) or the group's name (GROUP) in the CALLER's chat header + conversation list. Per-user only.
 *  An empty/whitespace string clears it (back to the real name). */
export class SetAliasDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({
    required: false,
    example: 'Alice (work)',
    description: 'Alias/remark (≤64 chars). Empty/omitted clears it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  alias?: string;
}

/**
 * Search a conversation's message history by substring. Returns lightweight {seq, createdAt} matches
 * (no full bodies) paginated by message-seq cursor — the client jumps the kernel to each match and the
 * server renders the bubble on demand via the normal query-messages path. Search covers the
 * PURE_TEXT envelope's `text` field and uploaded media's display filename (`name`).
 */
export class SearchMessagesDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({
    example: 'hello',
    description: 'Search keyword (substring, case-insensitive)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  keyword!: string;

  @ApiProperty({
    example: 20,
    description: 'Number of match ids to take (1-50)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50, { message: 'take must be at most 50' })
  take!: number;

  @ApiProperty({
    required: false,
    example: 42,
    description:
      'Cursor: return matches with seq < lastSeq (descending). Omit for the first page.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  lastSeq?: number;
}

/** Manually re-run federated media localize for one message (the user tapped retry in the detail
 *  view after a localize failure left the media inert). Idempotent — already-local digests skip the
 *  fetch and cost no quota. The endpoint returns the post-localize status ('ready' | 'failed'). */
export class RelocalizeMediaDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({
    example: 42,
    description: 'Per-thread message seq to re-localize',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  seq!: number;
}

/** Bulk media-status snapshot for mounted messages in one thread. Returns { seq, status } per
 *  existing seq; missing seqs are omitted. */
export class MediaMessageProgressDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({ example: 42, description: 'Per-thread message seq' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  seq!: number;
}

export class MediaFileProgressDto extends MediaMessageProgressDto {
  @ApiProperty({
    example: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    description: 'CAS digest for one file in the message',
  })
  @IsString()
  @IsNotEmpty()
  digest!: string;
}

export class MediaStatusDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({
    example: [42, 43],
    description: 'Per-thread message seqs to probe (1–50).',
    type: [Number],
  })
  @IsArray()
  @ArrayMaxSize(50)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  seqs!: number[];
}
