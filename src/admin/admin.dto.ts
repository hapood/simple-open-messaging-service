import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { type AuthenticationResponseJSON, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { AdminRole } from '../database/enums.js';
import { USER_ACCOUNT_RE, normalizeAccount } from '../common/account.js';
import { IsDisplayName } from '../common/validators.js';

/** Admin login input. */
export class AdminLoginDto {
  @ApiProperty({ example: 'admin', description: 'Admin account' })
  @IsString()
  @IsNotEmpty()
  account!: string;

  @ApiProperty({ example: 'P@ssw0rd', description: 'Password' })
  @IsString()
  @IsNotEmpty()
  password!: string;
}

/** Admin 2FA login verify input. Exactly one of `code` (6-digit TOTP) or `backupCode` must be present —
 *  `challengeToken` is the value POST admin/login returned in its twoFactorRequired response. */
export class AdminLoginVerifyDto {
  @ApiProperty({ description: 'Challenge token from POST admin/login (twoFactorRequired response)' })
  @IsString()
  @IsNotEmpty()
  challengeToken!: string;

  @ApiPropertyOptional({ example: '123456', description: '6-digit TOTP from the authenticator app' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code?: string;

  @ApiPropertyOptional({ example: 'ABCD-EFGH', description: 'A single-use backup (recovery) code' })
  @IsOptional()
  @IsString()
  backupCode?: string;
}

/** Confirm 2FA enrollment: submit the pending token (from setup) + the first 6-digit code. */
export class TwoFactorSetupVerifyDto {
  @ApiProperty({ description: 'Pending setup token from POST admin/2fa/setup' })
  @IsString()
  @IsNotEmpty()
  pendingToken!: string;

  @ApiProperty({ example: '123456', description: '6-digit TOTP shown by the authenticator after scanning' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}

/** Disable 2FA: the current password AND one live 2FA factor (TOTP or backup code) are required. */
export class TwoFactorDisableDto {
  @ApiProperty({ example: 'P@ssw0rd', description: 'Current password' })
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiPropertyOptional({ example: '123456', description: '6-digit TOTP' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code?: string;

  @ApiPropertyOptional({ example: 'ABCD-EFGH', description: 'A single-use backup code' })
  @IsOptional()
  @IsString()
  backupCode?: string;
}

/** Regenerate backup codes: one live 2FA factor (TOTP or backup code) is required. */
export class TwoFactorRegenerateDto {
  @ApiPropertyOptional({ example: '123456', description: '6-digit TOTP' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code?: string;

  @ApiPropertyOptional({ example: 'ABCD-EFGH', description: 'A single-use backup code' })
  @IsOptional()
  @IsString()
  backupCode?: string;
}

/** User list input (pagination + search). */
export class AdminListUsersDto {
  @ApiProperty({ required: false, example: 0, description: 'Number of records to skip (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  skip?: number;

  @ApiProperty({ required: false, example: 20, description: 'Number of records to take (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  take?: number;

  @ApiProperty({ required: false, example: 'alice', description: 'Fuzzy search by account/display name (optional)' })
  @IsOptional()
  @IsString()
  search?: string;
}

/** Admin create-user input. The admin provisions an account the user later signs into via whichever login
 *  method is enabled. `password` is required only when password login is enabled (loginMode ALL /
 *  PASSWORD_ONLY); for an OTP/QR-only account (loginMode APP_OTP_AND_QR) it is omitted and the account is
 *  created with NO password, bootstrapped instead by the one-time code the admin issues next. */
export class AdminCreateUserDto {
  @ApiProperty({
    example: 'alice',
    description: 'Login unique name: 3-31 chars, letters + digits + dots, start with a letter, case-insensitive',
  })
  @Transform(({ value }) => normalizeAccount(value))
  @Matches(USER_ACCOUNT_RE, {
    message: 'account must be 3-31 chars: letters + digits + dots, start with a letter',
  })
  account!: string;

  @ApiProperty({ example: 'Alice', description: 'Display name (1-30 chars; unicode/emoji allowed)' })
  @IsDisplayName()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({
    required: false,
    example: 'P@ssw0rd',
    description:
      'Initial password: 6-20 chars, allowed set [a-zA-Z0-9.@!#$%^&*()]. Required only when password login is enabled (loginMode ALL / PASSWORD_ONLY); omitted for OTP/QR-only accounts.',
  })
  @IsOptional()
  @Matches(/^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/, {
    message: 'password must be 6-20 chars of allowed set',
  })
  password?: string;
}

/** Unban input (IP and/or account; at least one must be provided). */
export class AdminUnbanDto {
  @ApiProperty({ required: false, example: '1.2.3.4', description: 'Banned IP (optional)' })
  @IsString()
  @IsOptional()
  ip?: string;

  @ApiProperty({ required: false, example: 'alice', description: 'Banned account account (optional)' })
  @IsString()
  @IsOptional()
  account?: string;
}

/** Push-token list input (pagination + search over account/token/deviceId). */
export class AdminListPushTokensDto {
  @ApiProperty({ required: false, example: 0, description: 'Records to skip (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  skip?: number;

  @ApiProperty({ required: false, example: 20, description: 'Records to take (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  take?: number;

  @ApiProperty({ required: false, example: 'alice', description: 'Fuzzy search account/token/deviceId (optional)' })
  @IsOptional()
  @IsString()
  search?: string;
}

/** Send-test-push input. `id` is a PushToken id; title/body are the literal notification text. */
export class AdminPushTestDto {
  @ApiProperty({ example: 42, description: 'PushToken id' })
  @Type(() => Number)
  @IsNumber()
  id!: number;

  @ApiProperty({ example: 'Test', description: 'Notification title' })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiProperty({ required: false, example: 'sent from admin console', description: 'Notification body (optional)' })
  @IsOptional()
  @IsString()
  body?: string;
}

/** System-wide active session list input (pagination + filter by userId/ip). */
export class AdminListSessionsDto {
  @ApiProperty({ required: false, example: 0, description: 'Number of records to skip (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  skip?: number;

  @ApiProperty({ required: false, example: 20, description: 'Number of records to take (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  take?: number;

  @ApiProperty({ required: false, example: 1, description: 'Filter by user id (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  userId?: number;

  @ApiProperty({ required: false, example: '1.2.3.4', description: 'Filter by IP (optional)' })
  @IsOptional()
  @IsString()
  ip?: string;
}

/** Pagination + filter for the federated-peer lifecycle list. `status` filters by trustLevel
 *  (pending | trusted | demoted | blocked); `search` is a fuzzy domain match. */
export class AdminListFederationPeersDto {
  @ApiProperty({ required: false, example: 0, description: 'Records to skip (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  skip?: number;

  @ApiProperty({ required: false, example: 20, description: 'Records to take (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  take?: number;

  @ApiProperty({ required: false, example: 'bbb', description: 'Fuzzy search by peer domain (optional)' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    required: false,
    example: 'trusted',
    description: 'Filter by trust level: pending | trusted | demoted | blocked (optional)',
  })
  @IsOptional()
  @IsString()
  status?: string;
}

/** A peer's lifecycle event timeline query (how many recent events to return). */
export class AdminFederationPeerEventsDto {
  @ApiProperty({ required: false, example: 100, description: 'Max events to return (optional, default 100)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  take?: number;
}

/** Optional note attached to an admin block (recorded on the `blocked` lifecycle event). */
export class AdminFederationBlockDto {
  @ApiProperty({ required: false, example: 'spam source', description: 'Optional block note (≤255)' })
  @IsOptional()
  @IsString()
  note?: string;
}

/** Per-node daily-quota override fields (POST admin/quota/nodes/:domain). All optional; a null/absent
 *  field means "use the global default". Applies to the local node (domain == SOMS_DOMAIN, stored in
 *  SystemSetting 'quota:local') or a federated peer (stored on FederatedPeer). See QuotaService.setLimits. */
export class AdminSetQuotaDto {
  @ApiProperty({ required: false, example: 5000, description: 'Messages/day (null = default)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  dailyMsgLimit?: number | null;

  @ApiProperty({ required: false, example: 500, description: 'Image media items/day (null = default)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  dailyImageLimit?: number | null;

  @ApiProperty({ required: false, example: 50, description: 'Video/large-file media items/day (null = default)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  dailyLargeFileLimit?: number | null;

  @ApiProperty({ required: false, example: 100, description: 'Inbound friend ops/day — anti-spam (null = default)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  dailyRequestLimit?: number | null;

  @ApiProperty({ required: false, example: 52428800, description: 'Single-image byte cap (null = default)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxImageBytes?: number | null;

  @ApiProperty({ required: false, example: 524288000, description: 'Single-large-file byte cap (null = default)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxLargeFileBytes?: number | null;
}

/** Inputs to the S2S self-check: which NTP server to compare the clock against, and which DNS resolver
 *  to run lookups through (default 'system' = /etc/resolv.conf; a public resolver surfaces split-horizon
 *  / propagation issues). Both optional. */
export class AdminFederationSelfCheckDto {
  @ApiProperty({
    required: false,
    example: 'ntp.aliyun.com',
    description: 'NTP server used to measure clock skew (optional, default ntp.aliyun.com)',
  })
  @IsOptional()
  @IsString()
  ntpServer?: string;

  @ApiProperty({
    required: false,
    example: '223.5.5.5',
    description: "DNS resolver IP for lookups (optional, default 'system')",
  })
  @IsOptional()
  @IsString()
  dnsResolver?: string;
}

/** Audit-log query: pagination + filters. `action` is a substring match (e.g. 'user.' );
 *  `success` filters the outcome; `adminId` scopes to one actor. */
export class AdminAuditQueryDto {
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  @ApiPropertyOptional({ description: 'Substring over action (e.g. user., federation., session.)' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: 'Scope to one actor' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  adminId?: number;

  @ApiPropertyOptional({ description: 'Filter by outcome' })
  @IsOptional()
  @Type(() => Boolean)
  success?: boolean;
}

/** Admin self-management: paginated, searchable list of admin accounts. */
export class AdminManageListDto {
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  @ApiPropertyOptional({ description: 'Fuzzy search by linked user account (optional)' })
  @IsOptional()
  @IsString()
  search?: string;
}

/** Promote an existing User to an admin. */
export class AdminCreateDto {
  @ApiProperty({ example: 42, description: 'Id of the User to promote' })
  @Type(() => Number)
  @IsInt()
  userId!: number;

  @ApiProperty({ enum: AdminRole, description: 'Initial role' })
  @IsIn([AdminRole.SUPER_ADMIN, AdminRole.ADMIN, AdminRole.VIEWER])
  role!: AdminRole;
}

/** Change an admin's role. */
export class AdminSetRoleDto {
  @ApiProperty({ enum: AdminRole })
  @IsIn([AdminRole.SUPER_ADMIN, AdminRole.ADMIN, AdminRole.VIEWER])
  role!: AdminRole;
}

/** Apply one action to many users at once. Each affected user is processed through the same path as
 *  the single-user endpoint (so disable still force-logs-out, etc.). */
export class AdminUserBatchDto {
  @ApiProperty({ type: [Number], example: [3, 7], description: 'User ids to act on' })
  @IsArray()
  @IsInt({ each: true })
  ids!: number[];

  @ApiProperty({ enum: ['disable', 'enable', 'force-logout'] })
  @IsIn(['disable', 'enable', 'force-logout'])
  action!: 'disable' | 'enable' | 'force-logout';
}

/** Groups/threads list query (type=GROUP threads; fuzzy search over the group name/account). */
export class AdminGroupsListDto {
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  @ApiPropertyOptional({ description: 'Fuzzy search by group account / name' })
  @IsOptional()
  @IsString()
  search?: string;
}

// ── WebAuthn (passkey) admin self-service ──────────────────────────────────────

/** Begin passkey enrollment: the current password (re-auth) + an optional label. The re-auth closes the
 *  "stolen ≤15m access token enrolls an attacker passkey" gap without logging out every device. */
export class WebAuthnRegBeginDto {
  @ApiProperty({ example: 'P@ssw0rd', description: 'Current password (re-auth required to enroll a passkey)' })
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiPropertyOptional({ example: 'MacBook Touch ID', description: 'Optional label for this passkey (≤64)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  nickname?: string;
}

/** Confirm enrollment: the pending token + the browser's PublicKeyCredential creation response. */
export class WebAuthnRegFinishDto {
  @ApiProperty({ description: 'Pending token from POST admin/webauthn/registration/begin' })
  @IsString()
  @IsNotEmpty()
  pendingToken!: string;

  @ApiProperty({ description: 'RegistrationResponseJSON returned by startRegistration (browser)' })
  @IsObject()
  registrationResponse!: RegistrationResponseJSON;
}

/** Begin a passkey login: the challenge token from POST admin/login (the twoFactorRequired response). */
export class WebAuthnLoginBeginDto {
  @ApiProperty({ description: 'Challenge token from POST admin/login (twoFactorRequired response)' })
  @IsString()
  @IsNotEmpty()
  challengeToken!: string;
}

/** Finish a passkey login: both tokens + the browser's assertion response. */
export class WebAuthnLoginFinishDto {
  @ApiProperty({ description: 'Challenge token from POST admin/login' })
  @IsString()
  @IsNotEmpty()
  challengeToken!: string;

  @ApiProperty({ description: 'Pending token from POST admin/webauthn/login/begin' })
  @IsString()
  @IsNotEmpty()
  pendingToken!: string;

  @ApiProperty({ description: 'AuthenticationResponseJSON returned by startAuthentication (browser)' })
  @IsObject()
  assertionResponse!: AuthenticationResponseJSON;
}

/** Rename a saved passkey. The credential id comes from the route path param; the body carries the label. */
export class WebAuthnRenameDto {
  @ApiProperty({ example: 'MacBook Touch ID' })
  @IsString()
  @MaxLength(64)
  nickname!: string;
}
