import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Input for POST /notification-feed/query. The per-user message feed identifies changed threads; the
 * notification read model then builds a current, replace-by-tag snapshot from their unread messages.
 */
export class NotificationFeedQueryDto {
  @ApiProperty({
    required: false,
    default: 0,
    description: 'Exclusive per-user message-feed cursor.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  after?: number;

  @ApiProperty({
    required: false,
    enum: ['message', 'private'],
    default: 'message',
    description:
      '"message" returns a bounded recent-message sample for MessagingStyle. "private" returns counts and routing only; message content never leaves the server.',
  })
  @IsOptional()
  @IsIn(['message', 'private'])
  previewMode?: 'message' | 'private';

  @ApiProperty({
    required: false,
    description:
      "The client's per-thread dismiss HWM map { threadId: seq }. A thread's notification starts after the greater of this value and its server read watermark.",
  })
  @IsOptional()
  threadHwms?: Record<number, number>;
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
  @ApiProperty({
    description: "The notification's tag (which notification's action fired).",
  })
  @IsString()
  @IsNotEmpty()
  tag!: string;

  @ApiProperty({
    description:
      "The action id ('reply' | 'open' | …; 'dismiss' is handled client-side).",
  })
  @IsString()
  @IsNotEmpty()
  actionId!: string;

  @ApiProperty({ required: false, description: 'reply: the target thread.' })
  @IsInt()
  @IsOptional()
  threadId?: number;

  @ApiProperty({
    required: false,
    description: 'reply: the target message seq (routing).',
  })
  @IsInt()
  @IsOptional()
  seq?: number;

  @ApiProperty({
    required: false,
    description: 'reply: the inline-typed reply text.',
  })
  @IsString()
  @MaxLength(MAX_REPLY_TEXT)
  @IsOptional()
  replyText?: string;
}
