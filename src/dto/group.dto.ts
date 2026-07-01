import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';

/**
 * Group-domain request DTOs. Validation rules:
 * - groupName: the original controller's manual length>31 check is moved into @MaxLength(31) (overlong → 400);
 *   the original "empty name allowed" behavior is preserved (no @IsNotEmpty).
 * - id fields: @Type(()=>Number)+@IsInt with the global ValidationPipe transform converts JSON/string input
 *   to number (Prisma needs number).
 */

export class CreateGroupDto {
  /** Group name, max 31 chars (original controller checked length <= 31). */
  @ApiProperty({ example: 'dev-team', description: 'Group name (≤31 chars, empty allowed)' })
  @IsString()
  @MaxLength(31, { message: 'group name must less than 32 characters' })
  groupName: string;
}

export class InviteGroupDto {
  @ApiProperty({ example: 1, description: 'Invited user id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number;

  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId: number;
}

export class JoinGroupDto {
  @ApiProperty({ example: 'invite-token', description: 'Invitation token' })
  @IsString()
  token: string;
}

export class GroupIdDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId: number;
}
