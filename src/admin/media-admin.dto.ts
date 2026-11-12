import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

export class MediaPageDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  skip = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  userId?: number;
}

export class MediaFilesDto extends MediaPageDto {
  @IsOptional()
  @Matches(/^[a-f0-9]{1,64}$/)
  digest?: string;

  @IsOptional()
  @IsIn(['available', 'reclaimed'])
  status?: 'available' | 'reclaimed';
}

export class MediaBatchesDto extends MediaPageDto {
  @IsOptional()
  @IsIn(['pending', 'downloading', 'failed', 'ready'])
  status?: string;
}

export class MediaDigestDto {
  @Matches(/^[a-f0-9]{64}$/)
  digest!: string;
}
