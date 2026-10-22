import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import {
  PushPlatform,
  type PushPlatform as PushPlatformType,
} from '../database/enums.js';

/** Session-owned Web Push and FCM registration requests. */

export class RegisterDeviceDto {
  @ApiProperty({
    description: 'Session push generation received through HELLO or SSE.',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  pushSubscriptionRev!: number;

  @ApiProperty({
    description: 'Authenticated session ID received in HELLO.',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  sessionId!: number;
  @ApiProperty({
    example: 'dGhpcyBpcyBhIGZjbSB0b2tlbi4u',
    description:
      'ANDROID/IOS: the FCM registration token. WEB: the Web Push subscription endpoint URL. Unique per installation; stored directly on the authenticated session.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token!: string;

  @ApiProperty({
    enum: PushPlatform,
    description: 'Delivery platform (determines the server-side transport).',
  })
  @IsEnum(PushPlatform)
  platform!: PushPlatformType;

  @ApiProperty({
    required: false,
    description:
      "WEB only: the Web Push subscription's p256dh key (base64url). Required for WEB so the server can encrypt the payload.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  p256dh?: string;

  @ApiProperty({
    required: false,
    description:
      "WEB only: the Web Push subscription's auth key (base64url). Required for WEB.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  auth?: string;

  @ApiProperty({
    required: false,
    description:
      'Optional stable client installation id for diagnostics. Delivery suppression is bound to the authenticated session.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(127)
  deviceId?: string;
}

export class RegisterDeviceResultDto {
  @ApiProperty()
  sessionId!: number;

  @ApiProperty({ minimum: 1 })
  pushSubscriptionRev!: number;

  @ApiProperty({
    description:
      'False means the submitted revision was stale; reconcile the returned revision.',
  })
  registered!: boolean;
}

export class PushProbeStatusDto {
  @ApiProperty()
  probeId!: string;

  @ApiProperty({ enum: ['provider_accepted', 'device_received', 'failed'] })
  stage!: 'provider_accepted' | 'device_received' | 'failed';

  @ApiProperty()
  createdAt!: number;

  @ApiPropertyOptional()
  acceptedAt?: number;

  @ApiPropertyOptional()
  receivedAt?: number;

  @ApiPropertyOptional()
  latencyMs?: number;

  @ApiPropertyOptional()
  errorCode?: string;
}
