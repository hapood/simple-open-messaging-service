import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** Generate a fresh VAPID keypair server-side. The private key is never returned to the browser (write-only);
 *  only publicKey + subject come back. subject is optional and defaults to a mailto: contact. */
export class GenerateVapidDto {
  @ApiPropertyOptional({
    example: 'mailto:admin@example.com',
    description: 'Contact URL (mailto: or https:); optional — defaults to mailto:noreply@soms.local',
  })
  @IsOptional()
  @IsString()
  subject?: string;
}

/** Save (paste) an existing VAPID keypair — used to migrate keys without forcing browsers to re-subscribe.
 *  Validated before persisting (the keypair must be a genuine P-256 pair; see SettingsService.validateVapid). */
export class SaveVapidDto {
  @ApiProperty({ example: 'mailto:admin@example.com', description: 'Contact URL (mailto: or https:)' })
  @IsString()
  @IsNotEmpty()
  subject!: string;

  @ApiProperty({ description: 'Base64url uncompressed P-256 public key (65 bytes, leading 0x04)' })
  @IsString()
  @IsNotEmpty()
  publicKey!: string;

  @ApiProperty({ description: 'Base64url P-256 private key scalar (32 bytes)' })
  @IsString()
  @IsNotEmpty()
  privateKey!: string;
}
