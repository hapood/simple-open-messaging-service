import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { GroupRole } from '../database/enums.js';
import { IsValidAvatarPath } from '../upload/avatar-path.js';

/**
 * Group-domain request DTOs. Validation rules:
 * - id fields: @Type(()=>Number)+@IsInt with the global ValidationPipe transform converts JSON/string input
 *   to number (database ids are numeric).
 */

export class CreateGroupDto {
  /** Group name (≤31 chars). Required — the new-group form supplies a real name now. */
  @ApiProperty({ example: 'dev-team', description: 'Group name (≤31 chars)' })
  @IsString()
  @MaxLength(31, { message: 'group name must less than 32 characters' })
  name!: string;

  @ApiPropertyOptional({
    example: 'https://.../g.webp',
    description: 'Group avatar URL (optional)',
  })
  @IsValidAvatarPath()
  @IsOptional()
  avatar?: string;

  /** Group description / intro — shown as the subtitle under the name in the chat header. */
  @ApiProperty({
    required: false,
    example: 'Frontend team sync',
    description: 'Group description / intro (≤240 chars)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(240, {
    message: 'group description must be at most 240 characters',
  })
  description?: string;
}

export class InviteGroupDto {
  /** Friends to invite. Each target must already have an existing P2P friendship. */
  @ApiProperty({
    type: [Number],
    example: [3, 7],
    description:
      'Friend user ids to invite (each must be a friend with an existing P2P thread)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Type(() => Number)
  userIds!: number[];

  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId!: number;
}

/** Shared by group/info and group/leave — any group route keyed only by groupId. */
export class GroupIdDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId!: number;
}

export class GroupTerminalActionDto extends GroupIdDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Also delete this chat for the caller',
  })
  @IsOptional()
  @IsBoolean()
  deleteData?: boolean;
}

export class KickGroupDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId!: number;

  @ApiProperty({ example: 7, description: 'Member to remove' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;
}

export class TransferGroupDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId!: number;

  @ApiProperty({ example: 7, description: 'Active member to promote to owner' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toUserId!: number;
}

export class SetRoleGroupDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId!: number;

  @ApiProperty({ example: 7, description: 'Member whose role is changed' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;

  /** ADMIN or MEMBER only — ownership changes go through group/transfer. OWNER is rejected. */
  @ApiProperty({
    enum: GroupRole,
    example: GroupRole.ADMIN,
    description: 'New role (ADMIN | MEMBER)',
  })
  @IsEnum(GroupRole)
  role!: GroupRole;
}

export class UpdateGroupDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId!: number;

  @ApiProperty({
    required: false,
    example: 'dev-team',
    description: 'New group name (≤31 chars)',
  })
  @IsString()
  @MaxLength(31, { message: 'group name must less than 32 characters' })
  @IsOptional()
  name?: string;

  @ApiProperty({
    required: false,
    example: 'https://.../g.webp',
    description: 'New group avatar URL',
  })
  @IsValidAvatarPath()
  @IsOptional()
  avatar?: string;

  /** Updated group description / intro. Empty string clears it. */
  @ApiProperty({
    required: false,
    example: 'Frontend team sync',
    description: 'New group description / intro (≤240 chars)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(240, {
    message: 'group description must be at most 240 characters',
  })
  description?: string;

  @ApiProperty({
    required: false,
    example: false,
    description: 'Whether ordinary members may invite users',
  })
  @IsBoolean()
  @IsOptional()
  membersCanInvite?: boolean;
}
