import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsBoolean, Max, Min } from 'class-validator';

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
