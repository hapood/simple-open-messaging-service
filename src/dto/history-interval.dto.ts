import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

/** Mounted server-gap subscription bounds. Local `(left, right]`. */
export class HistoryIntervalQueryDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({
    example: 90,
    description: 'Local Message.seq lower bound, exclusive',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  left!: number;

  @ApiProperty({
    example: 110,
    description: 'Local Message.seq upper bound, inclusive',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  right!: number;
}
