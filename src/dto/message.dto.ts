import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ContentType } from '../database/enums.js';

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
  // JSON escaping can expand a 5,000-character text body substantially; the controller validates
  // the decoded `text` field against the product limit.
  @MaxLength(32000, { message: 'content envelope is too large' })
  content!: string;

  // Direct-send content types ONLY. Media is committed exclusively by the staged
  // /send-media + /upload* promotion flow; the other schema values are server-side.
  //  - INVITE: a system message carrying a server-SIGNED invite token, created exclusively by
  //    group/invite. Letting a client set it would let them forge invite cards / malformed payloads
  //    in any thread they belong to.
  // LINK is client-authorable too: the client sends only the URL as `content`, and
  // MessageController.sendMessage rebuilds the card server-side via LinkPreviewService (SSRF-safe OG
  // fetch + og:image localization) then re-validates the assembled JSON with parseLinkContent — so a
  // client cannot forge the card metadata or a non-upload image URL.
  @ApiProperty({
    enum: ['PURE_TEXT', 'LINK'],
    required: false,
    description:
      'Direct-send content type (defaults to PURE_TEXT). Media uses /send-media + /upload*.',
  })
  @IsOptional()
  @IsIn(['PURE_TEXT', 'LINK'])
  contentType?: ContentType;

  @ApiProperty({
    required: false,
    example: 'b3f4a1e2-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
    description:
      'Client-generated UUID for send idempotency. Retrying a send with the same clientMessageId returns the original Message instead of creating a duplicate. Omit for legacy/non-retried sends.',
  })
  @IsOptional()
  @IsUUID()
  clientMessageId?: string;
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

  @ApiProperty({ description: 'Client send-idempotency UUID' })
  @IsUUID()
  clientMessageId!: string;
}

/**
 * Client-probed display metadata for a staged media send. Only the fields the upload route does NOT
 * itself derive are carried here: w/h (pixels) for image/video and duration (seconds) for video/audio.
 * The CAS url, filename, byte size, and MIME are all server-generated at upload and injected at promote,
 * so they never appear in (and cannot be forged via) this DTO.
 */
export class SendMediaMetaDto {
  @ApiProperty({
    required: false,
    description: 'Image/video pixel width (client-probed)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  w?: number;

  @ApiProperty({
    required: false,
    description: 'Image/video pixel height (client-probed)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  h?: number;

  @ApiProperty({
    required: false,
    description: 'Video/audio duration in seconds (client-probed)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(86400)
  duration?: number;
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
    enum: ['IMAGE', 'FILE', 'VIDEO', 'AUDIO'],
    description:
      'Media content type being staged (PURE_TEXT uses /send-message directly).',
  })
  @IsIn(['IMAGE', 'FILE', 'VIDEO', 'AUDIO'])
  contentType!: ContentType;

  @ApiProperty({
    description:
      'Client-generated UUID identifying this staged send. The same value is sent on the subsequent upload to promote it; retrying the stage is idempotent.',
  })
  @IsUUID()
  clientMessageId!: string;

  @ApiProperty({
    required: false,
    default: false,
    description:
      'Explicit retry. When true, an existing failed stage owned by this user is moved back to pending.',
  })
  @IsOptional()
  @IsBoolean()
  retry?: boolean;

  @ApiProperty({
    required: false,
    type: SendMediaMetaDto,
    description:
      'Client-probed display metadata (w/h, duration). Omitted fields are not staged.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SendMediaMetaDto)
  meta?: SendMediaMetaDto;
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

  @ApiProperty({
    example: 1,
    description:
      'Cursor-row flag, NOT offset. 0 includes the lastId row; 1 excludes it (standard Prisma keyset idiom). Capped at 1 — arbitrary offset-on-top-of-cursor is not supported.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1)
  skip!: number;

  @ApiProperty({ example: 20, description: 'Number of records to take (1-50)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50, { message: 'take must be at most 50' })
  take!: number;

  @ApiProperty({
    required: false,
    example: 42,
    description:
      'Cursor row seq (keyset pagination, optional). Omit for the first page.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  lastSeq?: number;

  @ApiProperty({
    required: false,
    default: false,
    description:
      'Whether to stop this page before truncateSeq. The cached boundary row itself is excluded.',
  })
  @IsOptional()
  @IsBoolean()
  truncate?: boolean;

  @ApiProperty({
    required: false,
    example: 80,
    description:
      'Exclusive seq boundary when truncate=true. asc returns seq < truncateSeq; desc returns seq > truncateSeq.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  truncateSeq?: number;

  @ApiProperty({
    enum: ['desc', 'asc'],
    example: 'desc',
    description: 'Sort direction',
  })
  @IsIn(['desc', 'asc'])
  orderBy!: 'desc' | 'asc';
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
  localReadHwm!: number;
}

/** Pull per-thread read states changed in a bounded per-user revision range. */
export class ReadDeltaDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fromRevision!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  toRevision!: number;
}

/** Toggle mute for a conversation (the caller's ThreadParticipant row). */
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

/** Toggle pin for a conversation (the caller's ThreadParticipant row). */
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

/** Per-user "clear chat history": hides all messages up to now for the caller (peer's copy untouched). */
export class ClearHistoryDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;
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

/** Bulk media-status probe for a set of messages in one thread — the client's scroll backstop for
 *  missed MEDIA_STATUS frames. Returns { seq, status, sv } per existing seq; missing seqs are omitted. */
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
