import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { MAX_MEDIA_FILE_BYTES } from '../../shared/media-upload-limits.js';

export type UploadPartIntent = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';

export class InitResumableUploadDto {
  @ApiProperty()
  @IsUUID()
  clientMessageId!: string;

  @ApiProperty({
    description: 'Stable UUID for this logical file within the message batch',
  })
  @IsUUID()
  partId!: string;

  @ApiProperty({ minimum: 0, maximum: 9 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9)
  position!: number;

  @ApiProperty({ enum: ['IMAGE', 'VIDEO', 'AUDIO', 'FILE'] })
  @IsIn(['IMAGE', 'VIDEO', 'AUDIO', 'FILE'])
  intent!: UploadPartIntent;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  originalName!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  mimeType!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MEDIA_FILE_BYTES)
  totalBytes!: number;
}
