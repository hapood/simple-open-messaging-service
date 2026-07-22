import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
 * A message identified by its per-thread `(threadId, seq)` (the backend resolves it to the internal BigInt
 * `id` it never exposes). Used as: the threadlist's high-water mark (`from`/`to`/`since`) — the newest
 * message it has accounted for, ordered by the backend's strict-total-order `id` (NOT by SSE arrival order,
 * which can deliver out of sequence).
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
 * Input for POST /notifications/missed — the away-notification summary (NOTIFICATION renderers only: Web SW /
 * Android FCM-FGS / desktop). The server aggregates, per sender, the messages newer than `since` (the
 * client's high-water mark = the newest message in its IDB before it went to background; ordering confirmed
 * by /notifications/missed-summary, never SSE order) and authors ONE descriptor: "X, Y sent you N messages"
 * (or "999+" past the 1000-message sample) + a composited stacked-avatar icon. Returns `notifications[]` only
 * (no items, no pagination) — the away surface is a one-shot current snapshot, replace-by-tag.
 */
export class MissedDto {
  @ApiProperty({
    type: MissedCursorDto,
    required: false,
    description: 'High-water mark (threadId, seq): the newest message accounted before backgrounding. Absent on first-ever → clear (no notification).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MissedCursorDto)
  since?: MissedCursorDto | null;
}

/**
 * Input for POST /notifications/missed-summary — the threadlist's body pre-warm (preview + chat-open). A
 * DOUBLE-BOUNDARY `(from, to]` walk: `to` = the newest SSE signal (the pinned upper bound — pinning it makes
 * the walk converge; new messages arriving mid-walk are > `to` and wait for the next walk); `from` = the
 * client's high-water mark (exclusive lower bound, advancing). Returns one item per thread whose latest
 * message id ∈ `(from, to]` (its newest body), paginated; the client walks pages until `!hasMore`, then sets
 * HWM = `to`. `to ≤ from` (SSE delivered a stale/out-of-order message) → empty no-op (HWM unchanged).
 */
export class MissedSummaryDto {
  @ApiProperty({
    type: MissedCursorDto,
    required: false,
    description: 'High-water mark (threadId, seq), exclusive lower bound. Absent on first boot.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MissedCursorDto)
  from?: MissedCursorDto | null;

  @ApiProperty({
    type: MissedCursorDto,
    description: 'The newest SSE signal (threadId, seq), inclusive upper bound — pinned for this walk.',
  })
  @ValidateNested()
  @Type(() => MissedCursorDto)
  to!: MissedCursorDto;

  @ApiProperty({ required: false, default: 200, maximum: 200, description: 'Page size (threads).' })
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
 * `'soms-away'`); `actionId` selects the handler. Only `reply` reaches the backend (a single `threadId` +
 * `replyText`). The away-summary's `dismiss` button is a PURE frontend op — the client just closes the shade
 * and never POSTs; the backend does not advance the read watermark on the shade's behalf (that happens on
 * `POST /thread/mark-read` when the user opens a thread). Body-tap is reported as `actionId:'open'`
 * (telemetry only — the client opens the thread itself).
 */
export class ReportActionDto {
  @ApiProperty({ description: "The notification's tag (which notification's action fired)." })
  @IsString()
  @IsNotEmpty()
  tag!: string;

  @ApiProperty({ description: "The action id ('reply' | 'open' | …; 'dismiss' is handled client-side)." })
  @IsString()
  @IsNotEmpty()
  actionId!: string;

  @ApiProperty({ required: false, description: 'reply: the target thread.' })
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
