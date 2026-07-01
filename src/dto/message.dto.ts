import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ContentType } from '../prisma/generated/client.js';

/** Message-domain request DTOs. Validation rules are ported from the original message.controller inline types. */

export class SendMessageDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId: number;

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
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId: number;

  @ApiProperty({
    example: 0,
    description: 'Number of records to skip (pagination)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number;

  @ApiProperty({ example: 20, description: 'Number of records to take (1-50)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50, { message: 'take must be at most 50' })
  take: number;

  @ApiProperty({
    required: false,
    example: '9007199254740993',
    description: 'Cursor (BigInt→string, optional)',
  })
  @IsOptional()
  @IsString()
  lastId?: string;

  @ApiProperty({
    enum: ['desc', 'asc'],
    example: 'desc',
    description: 'Sort direction',
  })
  @IsIn(['desc', 'asc'])
  orderBy: 'desc' | 'asc';
}

/**
 * Mark a conversation read up to a given message. Omit lastReadMessageId to mark ALL current messages
 * read (uses the thread's denormalized lastMessageId). The id is BigInt → carried as a string on the wire.
 */
export class MarkReadDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId: number;

  @ApiProperty({
    required: false,
    example: '9007199254740993',
    description:
      'Mark read up to (and including) this message id (BigInt→string). Omit to mark all current messages read.',
  })
  @IsOptional()
  @IsString()
  lastReadMessageId?: string;
}
