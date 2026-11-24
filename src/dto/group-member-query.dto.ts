import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { ProfiledAddress } from '../../shared/profiled-address.js';
import { GroupRole } from '../database/enums.js';

export class QueryGroupMembersDto {
  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  threadId!: number;

  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  search?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  excludeSelf?: boolean;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cursor?: string | null;
}

export class GroupMemberQueryItemDto implements ProfiledAddress {
  @ApiProperty()
  account!: string;

  @ApiProperty({ minimum: 0 })
  publisherNamespaceId!: number;

  @ApiProperty({ minimum: 0 })
  profileNamespaceId!: number;

  @ApiProperty({ minimum: 0 })
  profileRev!: number;

  @ApiProperty({ enum: GroupRole })
  role!: GroupRole;
}

export class GroupMemberQueryPageDto {
  @ApiProperty({ type: [GroupMemberQueryItemDto] })
  items!: GroupMemberQueryItemDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
