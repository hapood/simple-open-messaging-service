import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Input for the repurposed POST /notifications/missed — the cross-thread incremental-sync endpoint.
 *
 * Two natural calls:
 *  - init (no `since`, no `cursor`): the server returns the newest message per thread (a preview seed).
 *  - catch-up (`since` on the first page — the client's local high-water-mark, i.e. the `createdAt` ms
 *    of the newest message it has — then `cursor` on subsequent pages): paginated messages newer than
 *    the bound, time-ascending, looped until `hasMore:false`.
 *
 * `summary:true` selects the LEGACY unread-thread snapshot shape (UnreadThreadItem[]) used by the
 * FCM/WorkManager notification coalescing during the transition; the default returns paginated messages.
 */
export class MissedDto {
  @ApiProperty({
    required: false,
    description:
      'High-water-mark: epoch-ms `createdAt` of the newest message the client has. Absent (with no cursor) → init seed.',
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  since?: number | null;

  @ApiProperty({
    required: false,
    description:
      'Opaque pagination cursor returned by the previous page (takes precedence over `since`).',
  })
  @IsString()
  @IsOptional()
  cursor?: string;

  @ApiProperty({ required: false, default: 50, maximum: 200, description: 'Page size (messages).' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  take?: number;

  @ApiProperty({
    required: false,
    default: false,
    description:
      'Legacy unread-thread summary (FCM/WorkManager coalescing) instead of paginated messages.',
  })
  @IsBoolean()
  @IsOptional()
  summary?: boolean;
}
