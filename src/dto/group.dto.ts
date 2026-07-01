import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { GroupRole } from '../prisma/generated/client.js';

/**
 * Group-domain request DTOs. Validation rules:
 * - id fields: @Type(()=>Number)+@IsInt with the global ValidationPipe transform converts JSON/string input
 *   to number (Prisma needs number).
 * - memberIds: @Type(()=>Number) transforms each array element; @IsInt({each:true}) validates.
 */

export class CreateGroupDto {
  /** Group name (≤31 chars). Required — the new-group form supplies a real name now. */
  @ApiProperty({ example: 'dev-team', description: 'Group name (≤31 chars)' })
  @IsString()
  @MaxLength(31, { message: 'group name must less than 32 characters' })
  name: string;

  @ApiProperty({
    required: false,
    example: 'https://.../g.webp',
    description: 'Group avatar URL (optional)',
  })
  @IsString()
  @IsOptional()
  avatar?: string;

  /**
   * Friends to add as MEMBER participants directly at creation (WhatsApp-style — they join
   * without an invite token). Each must be an APPROVED friend of the creator; the controller
   * validates that. Members added here are not announced via the invite-message flow.
   */
  @ApiProperty({
    required: false,
    type: [Number],
    example: [3, 7],
    description: 'Friend user ids to add as members at creation (must be friends)',
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  memberIds?: number[];
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

/** Shared by group/info, group/members, group/leave — any group route keyed only by groupId. */
export class GroupIdDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId: number;
}

export class KickGroupDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId: number;

  @ApiProperty({ example: 7, description: 'Member to remove' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number;
}

export class TransferGroupDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId: number;

  @ApiProperty({ example: 7, description: 'Active member to promote to owner' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toUserId: number;
}

export class SetRoleGroupDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId: number;

  @ApiProperty({ example: 7, description: 'Member whose role is changed' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number;

  /** ADMIN or MEMBER only — ownership changes go through group/transfer. OWNER is rejected. */
  @ApiProperty({ enum: GroupRole, example: GroupRole.ADMIN, description: 'New role (ADMIN | MEMBER)' })
  @IsEnum(GroupRole)
  role: GroupRole;
}

export class UpdateGroupDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId: number;

  @ApiProperty({ required: false, example: 'dev-team', description: 'New group name (≤31 chars)' })
  @IsString()
  @MaxLength(31, { message: 'group name must less than 32 characters' })
  @IsOptional()
  name?: string;

  @ApiProperty({
    required: false,
    example: 'https://.../g.webp',
    description: 'New group avatar URL',
  })
  @IsString()
  @IsOptional()
  avatar?: string;
}
