import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
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
  @MaxLength(5000, { message: 'content must be at most 5000 characters' })
  content: string;

  // Client-authorable content types ONLY. The other schema values are server-side and must never
  // be settable by a client:
  //  - INVITE: a system message carrying a server-SIGNED invite token, created exclusively by
  //    group/invite. Letting a client set it would let them forge invite cards / malformed payloads
  //    in any thread they belong to.
  //  - VIDEO/AUDIO: no upload pipeline exists yet, so a client has no legitimate way to author
  //    them; allowing them would store arbitrary unvalidated content under those types.
  // FILE is allowed because POST /upload/file is the validated client-authoring path, and the
  // FILE content shape (url/name/size/mimeType) is re-validated by parseFileContent in
  // MessageController.sendMessage — a client cannot forge a non-upload URL or disallowed type.
  // Add a type here only when a validated client-authoring path exists.
  @ApiProperty({
    enum: ContentType,
    required: false,
    description:
      'Client-authorable content type (defaults to PURE_TEXT). INVITE is server-only; VIDEO/AUDIO have no upload pipeline yet.',
  })
  @IsOptional()
  @IsIn(['PURE_TEXT', 'IMAGE', 'FILE'])
  contentType?: ContentType;

  @ApiProperty({
    required: false,
    example: 'b3f4a1e2-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
    description:
      'Client-generated UUID for send idempotency. Retrying a send with the same clientMessageId returns the original Message instead of creating a duplicate. Omit for legacy/non-retried sends.',
  })
  @IsOptional()
  @IsUUID()
  clientMessageId?: string;
}

export class QueryMessagesDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId: number;

  @ApiProperty({
    example: 1,
    description:
      'Cursor-row flag, NOT offset. 0 includes the lastId row; 1 excludes it (standard Prisma keyset idiom). Capped at 1 — arbitrary offset-on-top-of-cursor is not supported.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1)
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
  @Matches(/^\d+$/, { message: 'lastReadMessageId must be a numeric string' })
  lastReadMessageId?: string;
}
