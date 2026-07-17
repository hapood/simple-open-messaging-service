import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
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
      "Client kind = device platform: 'app' (native), 'web' (browser), or 'desktop' (Tauri). Informational — persisted on the row for the device-list icon/label; the lifetime is driven by `trusted`, not `client`. Omitted → 'web'.",
  })
  @IsIn(['app', 'web', 'desktop'])
  @IsOptional()
  client?: 'app' | 'web' | 'desktop';

  @ApiProperty({
    required: false,
    default: true,
    description:
      'Cookie persistence for the pure-httpOnly browser path: true (default) → 14-day sliding cookie; false → session cookie (dropped when the browser closes, honoring "don\'t keep me logged in"). Native clients ignore the cookie and this flag.',
  })
  @IsBoolean()
  @IsOptional()
  persistent?: boolean;

  @ApiProperty({
    required: false,
    default: false,
    description:
      "Trust this device: request a permanent (revocation-only) session whose token the client will keep in OS secure storage. Honored only for the 'desktop' client (OS keyring); ignored for 'web' (a browser can't store a bearer token securely) and implicit-true for 'app' (the native app is always trusted).",
  })
  @IsBoolean()
  @IsOptional()
  trusted?: boolean;
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

/** One-time-code (admin-issued) login input — the Android long-term (`app`) session login method. The code
 *  is bound to the account at issue time, so the user enters their account + the 6-digit code. */
export class OtpLoginDto {
  @ApiProperty({ example: 'alice', description: 'Account the one-time code was issued for.' })
  @Transform(({ value }) => normalizeAccount(value))
  @Matches(USER_ACCOUNT_RE, { message: 'invalid account' })
  account!: string;

  @ApiProperty({ example: '123456', description: 'The 6-digit one-time login code (admin-issued).' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;

  @ApiProperty({ required: false, description: 'Human-readable device label (shown in the device list).' })
  @IsString()
  @IsOptional()
  device?: string;
}

/** QR-login create input (desktop/web). `client` is the device platform (constrained to web/desktop — a
 *  QR-issued session is never an `app` session); `trusted` opts a desktop into a permanent session. */
export class QrCreateDto {
  @ApiProperty({
    enum: ['web', 'desktop'],
    default: 'web',
    required: false,
    description: "Client kind for the issued session: 'web' (browser) or 'desktop' (Tauri). Never 'app'.",
  })
  @IsIn(['web', 'desktop'])
  @IsOptional()
  client?: 'web' | 'desktop';

  @ApiProperty({
    required: false,
    default: false,
    description:
      "Trust this desktop: mint a permanent (revocation-only) session whose token the desktop keeps in OS keyring. Honored only for 'desktop' (ignored for 'web' — a browser can't store a bearer token securely).",
  })
  @IsBoolean()
  @IsOptional()
  trusted?: boolean;
}

/** QR-login poll input (desktop/web) — check a token's status; on 'confirmed' the response carries the
 *  session token. Polled at ~1.5s. */
export class QrPollDto {
  @ApiProperty({ description: 'The QR sign-in token returned by /auth/qr/create.' })
  @IsString()
  @IsNotEmpty()
  qrToken!: string;

  @ApiProperty({ required: false, description: 'Human-readable device label (shown in the device list).' })
  @IsString()
  @IsOptional()
  device?: string;
}

/** QR-login scan/confirm input (the phone side, authenticated) — the token the phone scanned from the
 *  desktop's QR. */
export class QrTokenDto {
  @ApiProperty({ description: 'The QR sign-in token scanned from the desktop QR.' })
  @IsString()
  @IsNotEmpty()
  qrToken!: string;
}

/** logout input: the session token to revoke (possession of the token authorizes its own revocation).
 *  Optional so a client with no token held (already logged out) no-ops gracefully. */
export class LogoutDto {
  @ApiProperty({
    required: false,
    description: 'Session token to revoke (the per-device credential).',
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

/** Set-own-password input — the forced first-time set right after an admin-generated initial password,
 *  OR a voluntary set by an OTP/QR-only user enabling password login. No old password: the caller is already
 *  session-authenticated. `newPassword` reuses RegisterDto's 6-20 allowed-character rule. */
export class SetPasswordDto {
  @ApiProperty({
    example: 'MyOwnP@ss1',
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
