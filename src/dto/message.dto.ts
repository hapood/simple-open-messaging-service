import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ContentType } from '../prisma/generated/client.js';

/** Message-domain request DTOs. Validation rules are ported from the original message.controller inline types. */

export class SendMessageDto {
  @ApiProperty({ example: 1, description: 'User thread id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userThreadId: number;

  @ApiProperty({ example: 'hello', description: 'Message content' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiProperty({
    enum: ContentType,
    required: false,
    description: 'Content type (defaults to PURE_TEXT)',
  })
  @IsOptional()
  @IsIn(['PURE_TEXT', 'INVITE', 'IMAGE', 'VIDEO', 'FILE', 'AUDIO'])
  contentType?: ContentType;
}

export class QueryMessagesDto {
  @ApiProperty({ example: 1, description: 'User thread id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userThreadId: number;

  @ApiProperty({ example: 0, description: 'Number of records to skip (pagination)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number;

  @ApiProperty({ example: 20, description: 'Number of records to take (pagination)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take: number;

  @ApiProperty({
    required: false,
    example: '9007199254740993',
    description: 'Cursor (BigInt→string, optional)',
  })
  @IsOptional()
  @IsString()
  lastId?: string;

  @ApiProperty({ enum: ['desc', 'asc'], example: 'desc', description: 'Sort direction' })
  @IsIn(['desc', 'asc'])
  orderBy: 'desc' | 'asc';
}
