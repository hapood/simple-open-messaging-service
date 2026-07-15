import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { IsDisplayName } from '../common/validators.js';
import { USER_ACCOUNT_RE, normalizeAccount } from '../common/account.js';

/**
 * Auth request DTOs. Validation rules are ported 1:1 from the original inline controller checks to avoid
 * behavior drift. OpenAPI schema is annotated per-field with @ApiProperty (consistent with the response
 * DTOs; the swagger plugin shim is intentionally not used).
 */

/** Login input. Credentials are verified by LocalStrategy; @Body goes through the global ValidationPipe whitelist. The body holds only server-consumed fields — client-side concerns like "remember me" are out of contract. */
export class LoginDto {
  @ApiProperty({ example: 'alice', description: 'Login unique name' })
  @Transform(({ value }) => normalizeAccount(value))
  @IsString()
  @IsNotEmpty()
  account!: string;

  @ApiProperty({ example: 'P@ssw0rd', description: 'Password' })
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiProperty({
    required: false,
    example: 'web-chrome',
    description: 'Device identifier (optional)',
  })
  @IsString()
  @IsOptional()
  device?: string;

  @ApiProperty({
    required: false,
    enum: ['app', 'web', 'desktop'],
    default: 'web',
    description:
      "Client kind, selects the session-token lifetime policy: 'app' (native, stored in OS secure storage) → no-expiry, revocation-only; 'web' (browser) / 'desktop' (Tauri, JS memory) → sliding 30-day. Persisted on the row for the device list. Omitted → 'web'.",
  })
  @IsIn(['app', 'web', 'desktop'])
  @IsOptional()
  client?: 'app' | 'web' | 'desktop';
}

/**
 * Registration input. Format validation (regex) lives here → failure flows through ValidationPipe → 400
 * (per the P0 ValidationPipe acceptance). Business validation (account collision) stays in the service,
 * returning 200 + code:2.
 */
export class RegisterDto {
  // Account grammar: letters + `.` only, case-insensitive. The Transform
  // lowercases on input (Postgres @@unique is case-sensitive — the /i flag alone is insufficient), then
  // @Matches enforces the grammar. The DB column is VarChar(31), so 31 is the hard ceiling.
  @ApiProperty({
    example: 'alice',
    description: 'Login unique name: 3-31 chars, letters + digits + dots, must start with a letter, case-insensitive',
  })
  @Transform(({ value }) => normalizeAccount(value))
  @Matches(USER_ACCOUNT_RE, {
    message: 'account must be 3-31 chars: letters + digits + dots, start with a letter (no leading/trailing/consecutive dots)',
  })
  account!: string;

  // Display name is the primary identity shown everywhere (lists, headers, avatars). Lenient on charset
  // — any visible unicode incl. CJK/emoji — but required + length-capped (see IsDisplayName).
  @ApiProperty({
    example: 'Alice',
    description: 'Display name (1-30 chars; unicode/emoji allowed)',
  })
  @IsDisplayName()
  @IsNotEmpty()
  name!: string;

  // 6-20 chars, allowed [a-zA-Z0-9.@!#$%^&*()] (original pwdRegex)
  @ApiProperty({
    example: 'P@ssw0rd',
    description: 'Password: 6-20 chars, allowed set [a-zA-Z0-9.@!#$%^&*()]',
  })
  @Matches(/^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/, {
    message: 'password must be 6-20 chars of allowed set',
  })
  password!: string;
}

/** refresh token input: shared by renew-access / renew-refresh. */
export class RefreshTokenDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIs...',
    description: 'refresh token',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;

  @ApiProperty({
    required: false,
    example: 'web-chrome',
    description: 'Device identifier (optional)',
  })
  @IsString()
  @IsOptional()
  device?: string;
}

/** logout input: refreshToken is required (legacy); accessJti + sessionToken are optional. */
export class LogoutDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIs...',
    description: 'refresh token',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;

  @ApiProperty({
    required: false,
    example: 'a1b2c3d4-e5f6-...',
    description:
      'jti of the current access token (optional; used to immediately blacklist it)',
  })
  @IsString()
  @IsOptional()
  accessJti?: string;

  @ApiProperty({
    required: false,
    description:
      'Session token to revoke (the native/web credential). Optional — present when the client holds one.',
  })
  @IsString()
  @IsOptional()
  sessionToken?: string;
}

/** Change-password input (newPassword reuses RegisterDto's 6-20 allowed-character rule). */
export class ChangePasswordDto {
  @ApiProperty({ example: 'OldP@ss1', description: 'Current password' })
  @IsString()
  @IsNotEmpty()
  oldPassword!: string;

  @ApiProperty({
    example: 'NewP@ss2',
    description: 'New password: 6-20 chars, allowed set [a-zA-Z0-9.@!#$%^&*()]',
  })
  @Matches(/^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/, {
    message: 'newPassword must be 6-20 chars of allowed set',
  })
  newPassword!: string;
}

/** Revoke a single session by its device-list row id. Ownership is verified server-side, so only the
 *  id is needed. */
export class RevokeSessionDto {
  @ApiProperty({
    example: 42,
    description: 'id of the SessionToken row to revoke, as shown in GET /auth/sessions',
  })
  @Type(() => Number)
  @IsInt()
  id!: number;
}
