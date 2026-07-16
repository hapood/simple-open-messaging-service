import { ApiProperty } from '@nestjs/swagger';

/**
 * Login-method policy advertised to clients via `GET /config`. Selects which of the three login methods
 * (password / admin-issued one-time code / QR-scan) are enabled.
 *
 *  - ALL            (1) every method: password everywhere; admin-issued one-time code on Android; QR-scan
 *                       on desktop/web.
 *  - APP_OTP_AND_QR (2) password disabled. Android logs in with an admin-issued one-time code (long-term
 *                       `app` session); desktop/web log in via QR-scan confirmed by an already-logged-in
 *                       phone (2-week sliding `web`/`desktop` session).
 *  - PASSWORD_ONLY  (3) only account+password, on every client.
 */
export enum LoginMode {
  ALL = 1,
  APP_OTP_AND_QR = 2,
  PASSWORD_ONLY = 3,
}

/**
 * Response payload of `GET /api/v1/config` — public, unauthenticated site configuration a client fetches
 * once at bootstrap to decide which login UI to render and whether self-registration is offered.
 */
export class PublicConfigDto {
  @ApiProperty({
    example: false,
    description:
      'Whether end-user self-registration (POST user/register) is open. When false, accounts are created by admins only and the register UI is hidden.',
  })
  registrationOpen!: boolean;

  @ApiProperty({
    enum: LoginMode,
    enumName: 'LoginMode',
    example: LoginMode.APP_OTP_AND_QR,
    description: 'Which login methods are enabled (see LoginMode).',
  })
  loginMode!: LoginMode;
}

/**
 * The public site configuration — the single source of truth for the registration flag and the enabled
 * login methods. Hardcoded for now (admin-provisioned model: registration closed; login = Android
 * one-time code + desktop/web QR-scan). When operators need to flip this at runtime, the natural home is
 * the `SystemSetting` KV read through the global `SettingsService` (its header already anticipates feature
 * flags); until then a single const is the source of truth and `GET /config` serves it verbatim.
 */
export const PUBLIC_CONFIG: {
  registrationOpen: boolean;
  loginMode: LoginMode;
} = {
  registrationOpen: false,
  loginMode: LoginMode.APP_OTP_AND_QR,
};

/** Password login is available under ALL and PASSWORD_ONLY; disabled under APP_OTP_AND_QR. */
export function isPasswordLoginEnabled(mode: LoginMode): boolean {
  return mode === LoginMode.ALL || mode === LoginMode.PASSWORD_ONLY;
}
