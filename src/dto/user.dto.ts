import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsDisplayName } from '../common/validators.js';

/**
 * User-domain request DTOs. Validation rules are ported from the original inline checks.
 * Note: IsNumber + Type(() => Number) with the global ValidationPipe transform converts JSON/string input
 * to number (database ids are numeric).
 */

export class UserIdDto {
  @ApiProperty({ example: 1, description: 'User id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;
}

export class DeleteFriendDto {
  @ApiProperty({ example: 'alice', description: 'Friend account' })
  @IsString()
  @IsNotEmpty()
  account!: string;

  @ApiPropertyOptional({
    example: 'peer.example',
    description: 'Friend home domain. Omit for a local account.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(63)
  domain?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Also delete this chat for the caller',
  })
  @IsOptional()
  @IsBoolean()
  deleteData?: boolean;
}

/** Exact account lookup input. POST /user/resolve accepts local/our-domain lookup; the temporary
 * federated SSE endpoint requires both account and a foreign domain. The client splits a typed
 * `alice@bbb.com`; the API never carries an @-joined string. */
export class UserResolveDto {
  @ApiProperty({
    example: 'alice',
    description: "Account (a local account, or the peer user's account)",
  })
  @IsString()
  @IsNotEmpty()
  account!: string;

  @ApiProperty({
    required: false,
    example: 'bbb.com',
    description: 'Peer domain. Omitted/empty = local lookup.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(63)
  domain?: string;
}

/** Local user discovery (fuzzy). Matches account OR display name case-insensitively; min 2 chars so a
 *  single keystroke can't enumerate the user base. take is clamped server-side (see POST /user/search).
 *  Federated users are NOT discoverable here — resolve those by exact account + domain via UserResolveDto. */
export class UserSearchDto {
  @ApiProperty({
    example: 'ali',
    description: 'Search query (≥2 chars; matches account OR display name)',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2, { message: 'q must be at least 2 chars' })
  q!: string;

  @ApiProperty({
    required: false,
    example: 0,
    description: 'Records to skip (optional)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiProperty({
    required: false,
    example: 20,
    description: 'Records to take (1-20; clamped server-side)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take?: number;
}

/** Pre-flight trust check for a federated address search: has mutual trust with this peer domain
 *  already been established? Drives the client's first-contact affordance — a "Connecting to
 *  <domain>…" banner shown only when a handshake is actually expected (the server knows whether a
 *  FederatedPeer 'trusted' row exists), rather than guessed from request latency. */
export class PeerTrustStatusDto {
  @ApiProperty({
    example: 'bbb.local',
    description: 'Peer domain (the part after @ in a federated address)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  domain!: string;
}

/**
 * Create one complete profile revision. The account identity is immutable.
 */
export class UpdateProfileDto {
  @ApiProperty({
    required: true,
    example: 'Alice',
    description: 'Display name (1-30 chars; unicode/emoji allowed)',
  })
  @IsDisplayName()
  name!: string;

  @ApiProperty({
    required: true,
    example: 'Hey there!',
    description: 'Bio (≤120 chars)',
  })
  @IsString()
  @MaxLength(120, { message: 'bio must be at most 120 chars' })
  bio!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Canonical base64 image bytes. Omit to keep the previous avatar; null removes it.',
  })
  @IsOptional()
  @IsString()
  avatarBase64?: string | null;
}

export class UserAddressDto {
  @ApiProperty({ example: 'alice' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(31)
  account!: string;

  @ApiProperty({ example: 'local' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  domain!: string;
}

export class QueryUsersDto {
  @ApiProperty({
    type: UserAddressDto,
    isArray: true,
    example: [{ account: 'alice', domain: 'local' }],
    description: 'List of user addresses (≤100 per query)',
  })
  @IsArray()
  @ArrayMaxSize(100, { message: 'must contain at most 100 addresses' })
  @ValidateNested({ each: true })
  @Type(() => UserAddressDto)
  addresses!: UserAddressDto[];
}

/** Pull compacted client-state feed items in (afterFeedId, targetFeedId]. */
export class StateFeedDto {
  @ApiProperty({ example: 0, description: 'Last scanned feed id (exclusive)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterFeedId!: number;

  @ApiProperty({ example: 5, description: 'Fixed feed target (inclusive)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  targetFeedId!: number;
}
