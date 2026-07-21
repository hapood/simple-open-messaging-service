import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * The forward-pagination cursor — the client's last-accounted message, identified by its per-thread
 * `(threadId, seq)` (which the backend resolves to the internal BigInt `id` it never exposes). Absent → a
 * snapshot of the newest `take` threads (the background away-notification path; the initial threadlist
 * hydrate). Replaces the old ambiguous time-bound `since` + `skip` offset (a strict-total-order
 * `id > cursor` half-open interval whose adjacent pages never overlap, eliminating the same-ms boundary
 * duplication + the idempotent-apply dedup it forced).
 */
export class MissedCursorDto {
  @ApiProperty({ description: 'The cursor message thread id.' })
  @IsInt()
  threadId!: number;

  @ApiProperty({ description: 'The cursor message per-thread seq.' })
  @IsInt()
  @Min(0)
  seq!: number;
}

/**
 * Input for POST /notifications/missed — the unified missed summary (one row per thread: its newest
 * message body + unread count + display name) PLUS the server-authored notification descriptors.
 *
 *  - absent `cursor` → the newest `take` threads (the background away-notification: Android FCM /
 *    WorkManager / RealtimeService, the Web Push SW; the foreground desktop/browser unfocus pull).
 *  - `cursor` → forward pagination: threads whose latest message id > the cursor's resolved id, ASC.
 *
 * No `since`, no `skip` — one form. Pagination is over THREADS (`take`); the client advances its cursor to
 * the response `nextCursor` (the page's max-id item) and stops when it is null.
 */
export class MissedDto {
  @ApiProperty({
    type: MissedCursorDto,
    required: false,
    description:
      'Forward cursor (threadId, seq). Absent → newest `take` threads (the away-notification / initial hydrate).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MissedCursorDto)
  cursor?: MissedCursorDto | null;

  @ApiProperty({ required: false, default: 50, maximum: 200, description: 'Page size (threads).' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  take?: number;
}

/** Soft cap on an inline-reply text length (parity with the send-message content cap guard). */
const MAX_REPLY_TEXT = 2000;

/**
 * Input for POST /notifications/action — the client reports a notification button tap (or an inline reply)
 * back to the server. The `tag` identifies which notification's action fired (the away-summary's is
 * `'soms-away'`); `actionId` selects the handler. `mark-all-read` carries `threadIds` (the summary's
 * covered threads); `reply` carries a single `threadId` + `replyText`. Body-tap is reported as
 * `actionId:'open'` (telemetry only — the client opens the thread itself).
 */
export class ReportActionDto {
  @ApiProperty({ description: "The notification's tag (which notification's action fired)." })
  @IsString()
  @IsNotEmpty()
  tag!: string;

  @ApiProperty({ description: "The action id ('mark-all-read' | 'reply' | 'open' | …)." })
  @IsString()
  @IsNotEmpty()
  actionId!: string;

  @ApiProperty({
    type: [Number],
    required: false,
    description: 'mark-all-read: the covered thread ids (from descriptor.data.threadIds).',
  })
  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  threadIds?: number[];

  @ApiProperty({ required: false, description: 'reply: the single target thread.' })
  @IsInt()
  @IsOptional()
  threadId?: number;

  @ApiProperty({ required: false, description: 'reply: the target message seq (routing).' })
  @IsInt()
  @IsOptional()
  seq?: number;

  @ApiProperty({ required: false, description: 'reply: the inline-typed reply text.' })
  @IsString()
  @MaxLength(MAX_REPLY_TEXT)
  @IsOptional()
  replyText?: string;
}
