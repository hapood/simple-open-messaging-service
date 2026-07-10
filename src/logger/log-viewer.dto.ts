import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** POST /admin/logs/history query. Filters are ANDed; `level` is inclusive (a level shows itself +
 *  every more-severe level, matching the live viewer). `from`/`to` are ms-epoch time bounds. */
export class AdminLogHistoryDto {
  @ApiPropertyOptional({ default: 0, description: 'Offset for pagination (newest-first)' })
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

  @ApiPropertyOptional({ description: 'Case-insensitive substring over msg + context' })
  @IsOptional()
  @IsString()
  search?: string;
}
