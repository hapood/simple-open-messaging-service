import { ApiProperty } from '@nestjs/swagger';

/** A login method a client UI can offer. `password` is universal; `otp` (admin-issued one-time code)
 *  yields a long-term `app` session; `qr` (scan-to-sign-in) yields a 2-week sliding session confirmed
 *  by an already-logged-in phone. */
export type LoginMethod = 'password' | 'otp' | 'qr';

/** Every valid {@link LoginMethod}. Served to Swagger as the enum surface of `loginMethods` entries. */
export const LOGIN_METHODS: readonly LoginMethod[] = [
  'password',
  'otp',
  'qr',
];

/**
 * One advertised login method. The list's order is the client's presentation order (e.g. the login tab
 * order); `disabled` entries stay advertised so clients render them as visible-but-unavailable options.
 */
export class LoginMethodOptionDto {
  @ApiProperty({ enum: LOGIN_METHODS, enumName: 'LoginMethod', example: 'qr' })
  key!: LoginMethod;

  @ApiProperty({
    example: false,
    description:
      'Whether this method is turned off. Disabled entries remain in the list so clients can render them unavailable; the server rejects their auth endpoints with LOGIN_METHOD_DISABLED.',
  })
  disabled!: boolean;
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
    type: LoginMethodOptionDto,
    isArray: true,
    example: [
      { key: 'qr', disabled: false },
      { key: 'otp', disabled: false },
      { key: 'password', disabled: true },
    ],
    description:
      'Advertised login methods in the order clients should present them. Disabled entries are kept so clients can render them unavailable.',
  })
  loginMethods!: LoginMethodOptionDto[];

  @ApiProperty({
    enum: LOGIN_METHODS,
    enumName: 'LoginMethod',
    example: 'qr',
    description:
      'The method clients pre-select (e.g. the initially active login tab). Must be a non-disabled entry of loginMethods; clients fall back to the first non-disabled entry when this value is missing or invalid.',
  })
  defaultLoginMethod!: LoginMethod;
}

/**
 * The public site configuration — the single source of truth for the registration flag and the login
 * method policy (order, enablement, default). Hardcoded for now (admin-provisioned model: registration
 * closed; password disabled; QR-scan first, then one-time code). When operators need to flip this at
 * runtime, the natural home is the `SystemSetting` KV read through the global `SettingsService` (its
 * header already anticipates feature flags); until then a single const is the source of truth and
 * `GET /config` serves it verbatim.
 *
 * Invariants (pinned by public-config.spec.ts): every {@link LoginMethod} appears exactly once; at least
 * one entry is enabled; `defaultLoginMethod` is present and enabled.
 */
export const PUBLIC_CONFIG: PublicConfigDto = {
  registrationOpen: false,
  loginMethods: [
    { key: 'qr', disabled: false },
    { key: 'otp', disabled: false },
    { key: 'password', disabled: true },
  ],
  defaultLoginMethod: 'qr',
};

/** Whether `method` is advertised and enabled under {@link PUBLIC_CONFIG}. The single policy read shared
 *  by the auth-route guards and the admin-side gating. */
export function isLoginMethodEnabled(method: LoginMethod): boolean {
  const item = PUBLIC_CONFIG.loginMethods.find((i) => i.key === method);
  return item !== undefined && !item.disabled;
}
