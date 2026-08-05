import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { MessageReportStatus } from '../database/enums.js';

export class CreateMessageReportsDto {
  @ApiProperty({ example: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;

  @ApiProperty({ example: [31], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  @Min(0, { each: true })
  seqs!: number[];
}

export class AdminListMessageReportsDto {
  @ApiProperty({ required: false, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip = 0;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take = 20;

  @ApiProperty({ enum: Object.values(MessageReportStatus), required: false })
  @IsOptional()
  @IsIn(Object.values(MessageReportStatus))
  status?: MessageReportStatus;
}

export class ResolveMessageReportsDto {
  @ApiProperty({ example: ['1'], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @Matches(/^\d+$/, { each: true })
  reportIds!: string[];

  @ApiProperty({
    enum: [MessageReportStatus.UPHELD, MessageReportStatus.REJECTED],
  })
  @IsIn([MessageReportStatus.UPHELD, MessageReportStatus.REJECTED])
  status!:
    | typeof MessageReportStatus.UPHELD
    | typeof MessageReportStatus.REJECTED;
}
