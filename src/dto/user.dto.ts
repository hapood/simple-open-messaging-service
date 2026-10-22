import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
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

/** Exact account lookup input. POST /user/resolve accepts local/our-domain lookup; the temporary
 * federated SSE endpoint requires both account and a foreign domain. The client splits a typed
 * `alice@bbb.com`; the API never carries an @-joined string. */
export class UserResolveDto {
  @ApiProperty({
    example: 'alice',
    description: 'Exact user or group account (local or peer)',
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

  @ApiProperty({
    required: false,
    example: 12,
    description:
      'Server-local namespace id of the publisher vouching for the target ' +
      'identity. When both publisherNamespaceId and profileNamespaceId are ' +
      'present, the resolve uses a VOUCH possession challenge — verifying ' +
      'the vouched root key — instead of the first-contact PIN challenge.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  publisherNamespaceId?: number;

  @ApiProperty({
    required: false,
    example: 5,
    description:
      "Namespace id of the profile within the publisher's namespace space " +
      '(0 = the publisher itself). Required together with ' +
      'publisherNamespaceId for VOUCH-based resolve; absent degrades to PIN.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  profileNamespaceId?: number;

  @ApiProperty({
    required: false,
    example: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    description:
      'Mandatory root public key when using the VOUCH path. Contact cards must carry it so resolving never degrades to a naked domain trust decision.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(44)
  publicKey?: string;
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

/**
 * Create one complete profile revision. The account identity is immutable.
 */
export class UpdateProfileDto {
  @ApiProperty({
    required: true,
    example: 'Alice',
    description: 'Display name (1-31 chars; unicode/emoji allowed)',
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
