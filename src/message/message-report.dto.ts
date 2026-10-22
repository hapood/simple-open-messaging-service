import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class MessageTargetDto {
  @ApiProperty({ example: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  threadId!: number;

  @ApiProperty({ example: 31 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  seq!: number;
}

export class CreateMessageReportDto extends MessageTargetDto {}

export class AdminListMessageReportsDto {
  @ApiProperty({ type: Number, required: false, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip = 0;

  @ApiProperty({ type: Number, required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take = 20;

  @ApiProperty({ type: Boolean, required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isDeleted = false;
}
