import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { IsDisplayName } from '../common/validators.js';

/**
 * Auth request DTOs. Validation rules are ported 1:1 from the original inline controller checks to avoid
 * behavior drift. OpenAPI schema is annotated per-field with @ApiProperty (consistent with the response
 * DTOs; the swagger plugin shim is intentionally not used).
 */

/** Login input. Credentials are verified by LocalStrategy; @Body goes through the global ValidationPipe whitelist. The body holds only server-consumed fields — client-side concerns like "remember me" are out of contract. */
export class LoginDto {
  @ApiProperty({ example: 'alice', description: 'Login unique name' })
  @IsString()
  @IsNotEmpty()
  uniqName: string;

  @ApiProperty({ example: 'P@ssw0rd', description: 'Password' })
  @IsString()
  @IsNotEmpty()
  password: string;

  @ApiProperty({
    required: false,
    example: 'web-chrome',
    description: 'Device identifier (optional)',
  })
  @IsString()
  @IsOptional()
  device?: string;
}

/**
 * Registration input. Format validation (regex) lives here → failure flows through ValidationPipe → 400
 * (per the P0 ValidationPipe acceptance). Business validation (uniqName collision) stays in the service,
 * returning 200 + code:2.
 */
export class RegisterDto {
  // 3-31 chars, [a-zA-Z0-9_], must start with a letter (Telegram-style handle). The leading-letter +
  // alnum+underscore charset keeps handles URL/address-safe for the username@domain federation identity;
  // the DB column is VarChar(31), so 31 is the hard ceiling. Existing users keep their handles — this
  // only gates NEW registrations.
  @ApiProperty({
    example: 'alice',
    description: 'Login unique name: 3-31 chars [a-zA-Z0-9_], must start with a letter',
  })
  @Matches(/^[a-zA-Z][a-zA-Z0-9_]{2,30}$/, {
    message: 'uniqName must be 3-31 chars ([a-zA-Z0-9_]) and start with a letter',
  })
  uniqName: string;

  // Display name is the primary identity shown everywhere (lists, headers, avatars). Lenient on charset
  // — any visible unicode incl. CJK/emoji — but required + length-capped (see IsDisplayName).
  @ApiProperty({
    example: 'Alice',
    description: 'Display name (1-30 chars; unicode/emoji allowed)',
  })
  @IsDisplayName()
  @IsNotEmpty()
  name: string;

  // 6-20 chars, allowed [a-zA-Z0-9.@!#$%^&*()] (original pwdRegex)
  @ApiProperty({
    example: 'P@ssw0rd',
    description: 'Password: 6-20 chars, allowed set [a-zA-Z0-9.@!#$%^&*()]',
  })
  @Matches(/^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/, {
    message: 'password must be 6-20 chars of allowed set',
  })
  password: string;
}

/** refresh token input: shared by renew-access / renew-refresh. */
export class RefreshTokenDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIs...',
    description: 'refresh token',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;

  @ApiProperty({
    required: false,
    example: 'web-chrome',
    description: 'Device identifier (optional)',
  })
  @IsString()
  @IsOptional()
  device?: string;
}

/** logout input: refreshToken is required; accessJti is optional (immediately blacklists the current access). */
export class LogoutDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIs...',
    description: 'refresh token',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;

  @ApiProperty({
    required: false,
    example: 'a1b2c3d4-e5f6-...',
    description:
      'jti of the current access token (optional; used to immediately blacklist it)',
  })
  @IsString()
  @IsOptional()
  accessJti?: string;
}

/** Change-password input (newPassword reuses RegisterDto's 6-20 allowed-character rule). */
export class ChangePasswordDto {
  @ApiProperty({ example: 'OldP@ss1', description: 'Current password' })
  @IsString()
  @IsNotEmpty()
  oldPassword: string;

  @ApiProperty({
    example: 'NewP@ss2',
    description: 'New password: 6-20 chars, allowed set [a-zA-Z0-9.@!#$%^&*()]',
  })
  @Matches(/^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/, {
    message: 'newPassword must be 6-20 chars of allowed set',
  })
  newPassword: string;
}

/** Revoke a single session. */
export class RevokeSessionDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-...',
    description: 'jti of the session to revoke',
  })
  @IsString()
  @IsNotEmpty()
  jti: string;

  @ApiProperty({
    required: false,
    example: 'a1b2c3d4-e5f6-...',
    description:
      'jti of the current access token (optional; used to immediately blacklist it)',
  })
  @IsString()
  @IsOptional()
  accessJti?: string;
}
