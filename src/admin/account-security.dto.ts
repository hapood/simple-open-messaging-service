import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { SecurityAction } from './account-security.service.js';

export class SecurityProofDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  password!: string;
  @IsOptional()
  @Matches(/^\d{6}$/)
  code?: string;
  @IsOptional()
  @IsString()
  @MaxLength(64)
  backupCode?: string;
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  pendingToken?: string;
  @IsOptional()
  @IsObject()
  assertionResponse?: AuthenticationResponseJSON;
}
export class SecurityAssertionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  password!: string;
  @IsIn([
    'password',
    'totp-enable',
    'totp-disable',
    'backup-regenerate',
    'passkey-add',
    'passkey-remove',
  ])
  action!: SecurityAction;
  @IsOptional()
  @IsInt()
  @Min(1)
  target?: number;
}
export class AdminChangePasswordDto extends SecurityProofDto {
  @Matches(/^[a-zA-Z0-9.@!#$%^&*()]{6,20}$/)
  newPassword!: string;
}
export class SecurityEnrollmentDto extends SecurityProofDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  nickname?: string;
}
