import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  ValidateBy,
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
  @MaxLength(31, { message: 'group name must be at most 31 characters' })
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

export class GroupInviteAddressDto {
  @ApiProperty({ example: 'alice' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[^!\s@][^\s@]*$/)
  account!: string;

  @ApiProperty({
    example: 'example.com',
    description:
      'User home domain. For a local user, use the configured local identity domain.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  domain!: string;
}

export class InviteGroupDto {
  @ApiProperty({
    type: [GroupInviteAddressDto],
    description: 'Existing friends to invite by public address.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GroupInviteAddressDto)
  users!: GroupInviteAddressDto[];

  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId!: number;
}

/** Shared by group routes keyed only by groupId. */
export class GroupIdDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId!: number;
}

export class SetGroupAnnouncementDto extends GroupIdDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Plain text (1–4096 Unicode code points), or null to clear',
  })
  @ValidateBy({
    name: 'groupAnnouncementText',
    validator: {
      validate: (value: unknown) =>
        value === null ||
        (typeof value === 'string' &&
          [...value].length >= 1 &&
          [...value].length <= 4096),
    },
  })
  text!: string | null;
}

export class ReadGroupAnnouncementDto extends GroupIdDto {
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  announcementFeedId!: number;
}

/** Server-authoritative friend page for the group invitation picker. */
export class QueryGroupInviteCandidatesDto extends GroupIdDto {
  @ApiPropertyOptional({
    example: 42,
    description: 'Exclusive P2P thread-id cursor. Omit for the first page.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  afterThreadId?: number;

  @ApiPropertyOptional({
    example: 'alice',
    description: 'Optional case-insensitive account or display-name search.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ default: 20, description: 'Page size (1-50)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  take?: number;
}

/** Newest-first keyset page of projected USER→GROUP applications. */
export class QueryGroupJoinRequestsDto extends GroupIdDto {
  @ApiPropertyOptional({
    example: 123,
    description: 'Exclusive projection feed cursor. Omit for the newest page.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  before?: number;

  @ApiPropertyOptional({ default: 20, description: 'Page size (1-50)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  take?: number;
}

export class ReadGroupJoinRequestsDto extends GroupIdDto {
  @ApiProperty({
    example: 123,
    description:
      'Highest application projection feed id displayed by the client',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  joinRequestReadFeedId!: number;
}

class GroupMemberTargetDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId!: number;

  @ApiProperty({ example: 'alice', description: 'Member account' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(31)
  account!: string;

  @ApiProperty({ example: 'example.com', description: 'Member home domain' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  domain!: string;
}

export class HandleGroupJoinRequestDto extends GroupMemberTargetDto {}

export class KickGroupDto extends GroupMemberTargetDto {}

class GroupRosterMemberTargetDto {
  @ApiProperty({ example: 12, description: 'Group id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId!: number;

  @ApiProperty({ example: 'alice', description: 'Member account' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(31)
  account!: string;

  @ApiProperty({ example: 7, description: 'Member identity namespace id' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  namespaceId!: number;
}

export class TransferGroupDto extends GroupRosterMemberTargetDto {}

export class SetRoleGroupDto extends GroupRosterMemberTargetDto {
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
  @MaxLength(31, { message: 'group name must be at most 31 characters' })
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
}
