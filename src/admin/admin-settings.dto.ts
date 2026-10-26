import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsBoolean,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
} from 'class-validator';

const isZeroOrRange = (minimum: number, maximum: number) =>
  ValidateBy({
    name: 'isZeroOrRange',
    constraints: [minimum, maximum],
    validator: {
      validate: (value: unknown) =>
        Number.isInteger(value) &&
        (value === 0 ||
          ((value as number) >= minimum && (value as number) <= maximum)),
      defaultMessage: () =>
        `value must be 0 or an integer from ${minimum} to ${maximum}`,
    },
  });

/** The one-time-code validity window (minutes) an admin configures. Clamped to [1, 1440] (a day); the
 *  service clamps again on read so an out-of-range value can't break issuance, but validation here gives a
 *  clean error + keeps the stored value tidy. */
export class OtpTtlDto {
  @ApiProperty({
    example: 10,
    minimum: 1,
    maximum: 1440,
    description: 'One-time-code validity window in minutes (1-1440).',
  })
  @IsInt()
  @Min(1)
  @Max(1440)
  ttlMinutes!: number;
}

export class FederationDownloadLimitsDto {
  @ApiProperty({ example: 10, minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  global!: number;

  @ApiProperty({ example: 2, minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  perPeer!: number;

  @ApiProperty({ example: false, default: false })
  @IsBoolean()
  chunkDigestEnabled!: boolean;
}

export class FederationHttpLimitsDto {
  @ApiProperty({ example: 16, minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  global!: number;

  @ApiProperty({ example: 8, minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  perPeer!: number;
}

export class FederationHistoryAccessDto {
  @ApiProperty({ example: true, default: true })
  @IsBoolean()
  enabled!: boolean;
}

export class FederationTransportDto {
  @ApiProperty({ minimum: 60, maximum: 604800, example: 21600 })
  @IsInt()
  @Min(60)
  @Max(604800)
  keyCacheTtlSec!: number;

  @ApiProperty({ minimum: 1, maximum: 120, example: 12 })
  @IsInt()
  @Min(1)
  @Max(120)
  connectTimeoutSec!: number;

  @ApiProperty({
    minimum: 1,
    maximum: 600,
    example: 30,
    description:
      'Response-header wait and response-body inactivity timeout after connection establishment, shared by ordinary and media requests.',
  })
  @IsInt()
  @Min(1)
  @Max(600)
  requestIdleTimeoutSec!: number;

  @ApiProperty({ minimum: 262144, maximum: 67108864, example: 8388608 })
  @IsInt()
  @Min(262144)
  @Max(67108864)
  mediaChunkBytes!: number;

  @ApiProperty({ minimum: 0, maximum: 20, example: 5 })
  @IsInt()
  @Min(0)
  @Max(20)
  mediaMaxChunkRetries!: number;
}

export class AdminSessionPolicyDto {
  @ApiProperty({ minimum: 1, maximum: 24, example: 12 })
  @IsInt()
  @Min(1)
  @Max(24)
  ttlHours!: number;

  @ApiProperty({
    description: '0 disables idle expiry; otherwise 15-480 minutes.',
    example: 60,
  })
  @isZeroOrRange(15, 480)
  idleMinutes!: number;
}

export class UserQuotaDefaultsDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  dailyMsgLimit!: number;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  dailyRequestLimit!: number;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  dailyFileLimit!: number;

  @ApiProperty({ type: String, pattern: '^\\d+$', example: '1073741824' })
  @IsString()
  @MaxLength(16)
  @Matches(/^\d+$/)
  dailyFileBytesLimit!: string;
}

export class FederationQuotaDefaultsDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  dailyMsgLimit!: number;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  dailyRequestLimit!: number;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  dailySignalLimit!: number;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  dailyFileLimit!: number;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  dailyFileBytesLimit!: number;
}
