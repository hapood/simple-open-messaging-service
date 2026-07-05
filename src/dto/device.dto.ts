import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PushPlatform } from '../prisma/generated/client.js';

/**
 * Device registration DTOs for FCM push. The client obtains an FCM registration token from the
 * platform Firebase SDK (Android) and POSTs it here so the server can fan out data-only FCM messages
 * on NEW_MESSAGE for recipients with no live SSE connection (see PushService).
 */

export class RegisterDeviceDto {
  @ApiProperty({
    example: 'dGhpcyBpcyBhIGZjbSB0b2tlbi4u',
    description:
      'FCM registration token issued by the platform Firebase SDK. Unique per device+install; the server upserts on this field so an account switch re-owns the row.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token: string;

  @ApiProperty({
    enum: PushPlatform,
    description: 'Delivery platform (determines the server-side transport).',
  })
  @IsEnum(PushPlatform)
  platform: PushPlatform;

  @ApiProperty({
    required: false,
    description:
      'Optional client device_id (the web app\'s localStorage uuid from AuthService.getDeviceId). Aids diagnostics and future stale-token sweeps.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(127)
  deviceId?: string;
}
