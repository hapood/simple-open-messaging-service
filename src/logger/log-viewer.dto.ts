import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { LOG_OUTPUT_LEVELS, type LogOutputLevel } from './log-level.service.js';

/** POST /admin/logs/history query. Filters are ANDed; `level` is inclusive (a level shows itself +
 *  every more-severe level). `from`/`to` are ms-epoch time bounds. */
export class AdminLogHistoryDto {
  @ApiPropertyOptional({
    default: 0,
    description: 'Offset for pagination (newest-first)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  @ApiPropertyOptional({
    enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
    description: 'Inclusive minimum level',
  })
  @IsOptional()
  @IsString()
  level?: string;

  @ApiPropertyOptional({ description: 'Lower time bound, ms epoch' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  from?: number;

  @ApiPropertyOptional({ description: 'Upper time bound, ms epoch' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  to?: number;

  @ApiPropertyOptional({
    description: 'Case-insensitive substring over msg + context',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Exact structured log scope' })
  @IsOptional()
  @IsString()
  scope?: string;

  @ApiPropertyOptional({ description: 'Exact structured task identifier' })
  @IsOptional()
  @IsString()
  taskId?: string;
}

export class AdminLogOutputLevelDto {
  @ApiProperty({ enum: LOG_OUTPUT_LEVELS })
  @IsIn(LOG_OUTPUT_LEVELS)
  level!: LogOutputLevel;
}
