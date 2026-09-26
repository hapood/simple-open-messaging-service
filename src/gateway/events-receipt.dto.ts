import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

/** Confirm the exact feed head observed on this device session's current SSE stream. */
export class EventsReceiptDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  sseUuid!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  threadFeedEndId!: number;
}
