import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  PushPlatform,
  type PushPlatform as PushPlatformType,
} from '../database/enums.js';

/**
 * Device registration DTOs for FCM push. The client obtains an FCM registration token from the
 * platform Firebase SDK (Android) and POSTs it here so the server can fan out data-only FCM messages
 * on NEW_MESSAGE for recipients with no live SSE connection (see PushService).
 */

export class RegisterDeviceDto {
  @ApiProperty({
    example: 'dGhpcyBpcyBhIGZjbSB0b2tlbi4u',
    description:
      'ANDROID/IOS: the FCM registration token. WEB: the Web Push subscription endpoint URL. Unique per device+install; the server upserts on this field so an account switch re-owns the row.',
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
      "Optional client device_id (the web app's localStorage uuid from AuthService.getDeviceId). Aids diagnostics and future stale-token sweeps.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(127)
  deviceId?: string;
}

/** Start a one-off Android FCM delivery probe for the current device. */
export class CreateFcmProbeDto {
  @ApiProperty({ description: 'Current Android FCM registration token.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token!: string;
}
