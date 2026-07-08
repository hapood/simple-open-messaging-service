import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MessageThreadType } from '../prisma/generated/client.js';

/**
 * User-domain request DTOs. Validation rules are ported from the original inline checks.
 * Note: IsNumber + Type(() => Number) with the global ValidationPipe transform converts JSON/string input
 * to number (Prisma needs numeric ids).
 */

export class UserIdDto {
  @ApiProperty({ example: 1, description: 'User id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number;
}

/** Send a friend request, optionally with a ≤255-char note. Federated recipients are addressed by
 *  first resolving @localpart@domain via /user/resolve-federated (which mints/finds a local stub),
 *  then passing that stub's userId here — same DTO + path for local and federated. */
export class SendFriendRequestDto {
  @ApiProperty({ example: 1, description: 'User id (local user OR federated stub id)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number;

  @ApiProperty({ required: false, example: 'Hi from the conference', description: 'Friend-request note (≤255 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  message?: string;
}

/** Resolve a @localpart@domain handle to a local user (our domain) or a foreign stub (peer domain).
 *  FOLDED INTO /user/by-uniq-name: its `uniqName` field accepts a full handle too, so the federated
 *  resolve (signed GET /api/v1/s2s/users/:handle + find-or-create stub) lives there — no separate
 *  endpoint or DTO needed (consistent with how send/approve/delete-friend reuse their endpoints). */

/** Block or unblock a user (P2P). Independent of the friendship state machine — blocking survives an
 *  unfriend and applies to strangers. The message path drops fan-out to the blocker and filters
 *  query-messages so the blocker never sees the blocked user's messages. */
export class BlockDto {
  @ApiProperty({ example: 1, description: 'User id to block / unblock' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number;

  @ApiProperty({ example: true, description: 'true = block, false = unblock' })
  @IsBoolean()
  block: boolean;
}

export class ThreadIdDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId: number;
}

export class UserByUniqNameDto {
  @ApiProperty({ example: 'alice', description: 'Login unique name' })
  @IsString()
  @IsNotEmpty()
  uniqName: string;
}

/**
 * Update the current user's profile (nickname/bio). All fields optional; send only what changes.
 * handle (uniqName) cannot be changed here — identity changes go through a separate flow.
 */
export class UpdateProfileDto {
  @ApiProperty({
    required: false,
    example: 'Alice',
    description: 'Display name (1-30 chars)',
  })
  @IsOptional()
  @IsString()
  @Length(1, 30, { message: 'name must be 1-30 chars' })
  name?: string;

  @ApiProperty({
    required: false,
    example: 'Hey there!',
    description: 'Bio (≤120 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120, { message: 'bio must be at most 120 chars' })
  bio?: string;
}

export class QueryUsersDto {
  @ApiProperty({
    type: Number,
    isArray: true,
    example: [1, 2, 3],
    description: 'List of user ids (≤100 per query)',
  })
  @IsArray()
  @ArrayMaxSize(100, { message: 'must less than 100 userIds per query' })
  @IsInt({ each: true })
  userIds: number[];
}

export class QueryValidThreadDto {
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
    example: 100,
    description: 'Last id of the previous page (cursor, optional)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  lastId?: number;

  @ApiProperty({
    enum: MessageThreadType,
    required: false,
    description: 'Conversation type P2P|GROUP (optional filter)',
  })
  @IsOptional()
  type?: MessageThreadType;
}

export class QueryPendingThreadDto {
  @ApiProperty({
    example: 1_700_000_000_000,
    description: 'Millisecond timestamp: fetch pending items before this time',
  })
  @Type(() => Number)
  @IsInt()
  beforeDate: number;

  @ApiProperty({ example: 20, description: 'Number of records to take (1-50)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50, { message: 'take must be at most 50' })
  take: number;

  // Frontend queryToPending sends only { take, beforeDate } with no skip (relies on Prisma skip:undefined = no pagination).
  // Hence optional; when provided it is still validated as a non-negative integer.
  @ApiProperty({
    required: false,
    example: 0,
    description: 'Number of records to skip (optional)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;
}
