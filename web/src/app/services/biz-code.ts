import { TranslocoService } from '@jsverse/transloco';
import type { StandardResponse } from './model';

/**
 * Mirror of the backend `BusinessCode` enum (src/common/business-code.ts) — the stable numeric contract
 * every error response carries. Kept as plain `const` values (not an enum) so the `BIZ_CODE_KEY` map
 * stays a flat literal lookup. Update both sides together when a code is added.
 */
export const BusinessCode = {
  OK: 0,
  VALIDATION_FAILED: 10000,
  NOT_FOUND: 10001,
  ALREADY_EXISTS: 10002,
  UNAUTHENTICATED: 10003,
  FORBIDDEN: 10004,
  RATE_LIMITED: 10005,
  REFRESH_REUSE_DETECTED: 10006,
  SESSION_REVOKED: 10007,
  QUOTA_EXCEEDED: 10008,
  INVALID_CREDENTIALS: 10009,
  REGISTRATION_DISABLED: 10010,
  LOGIN_METHOD_DISABLED: 10011,
  OTP_INVALID: 10012,
  OTP_EXPIRED: 10013,
  OTP_CONSUMED: 10014,
  QR_INVALID: 10015,
  QR_EXPIRED: 10016,
  PASSWORD_NOT_SET: 10017,
  MUST_CHANGE_PASSWORD: 10018,
  INTERNAL: 10999,
  FRIEND_SELF: 20001,
  FRIEND_NOT_FOUND: 20002,
  INVITE_NOT_FOUND: 20010,
  INVITE_EXPIRED: 20011,
  INVITE_NOT_YOURS: 20012,
  INVITE_ALREADY_HANDLED: 20013,
  MESSAGE_EMPTY: 30001,
  THREAD_NOT_APPROVED: 30002,
  THREAD_NOT_FOUND: 30003,
  GROUP_INVALID_TOKEN: 40003,
  GROUP_OWNER_MUST_TRANSFER: 40004,
  GROUP_FORBIDDEN: 40005,
  GROUP_TARGET_NOT_MEMBER: 40006,
  GROUP_DISSOLVED: 40007,
  GROUP_FULL: 40008,
  FEDERATION_DELIVERY_FAILED: 50008,
  FEDERATION_QUOTA_EXCEEDED: 50011,
  FEDERATION_PAYLOAD_TOO_LARGE: 50012,
  FEDERATION_CAPABILITY_DISABLED: 50013,
  FEDERATION_NAMESPACE_INACTIVE: 50026,
} as const;

/**
 * Numeric business code → translation key. Error responses carry no `messageKey` on purpose: the numeric
 * `code` is the stable contract, and one map localizes every endpoint's errors uniformly. Success
 * outcomes that share code 0 but need disambiguation (e.g. friend-request "sent / already friends /
 * now friends") are localized via the backend-supplied `messageKey` instead.
 */
const BIZ_CODE_KEY: Readonly<Record<number, string>> = {
  [BusinessCode.VALIDATION_FAILED]: 'errors.biz.validation',
  [BusinessCode.NOT_FOUND]: 'errors.biz.notFound',
  [BusinessCode.ALREADY_EXISTS]: 'errors.biz.alreadyExists',
  [BusinessCode.UNAUTHENTICATED]: 'errors.biz.unauthenticated',
  [BusinessCode.FORBIDDEN]: 'errors.biz.forbidden',
  [BusinessCode.RATE_LIMITED]: 'errors.biz.rateLimited',
  [BusinessCode.REFRESH_REUSE_DETECTED]: 'errors.biz.refreshReuse',
  [BusinessCode.SESSION_REVOKED]: 'errors.biz.sessionRevoked',
  [BusinessCode.QUOTA_EXCEEDED]: 'errors.biz.quotaExceeded',
  [BusinessCode.INVALID_CREDENTIALS]: 'errors.biz.invalidCredentials',
  [BusinessCode.REGISTRATION_DISABLED]: 'errors.biz.registrationDisabled',
  [BusinessCode.LOGIN_METHOD_DISABLED]: 'errors.biz.loginMethodDisabled',
  [BusinessCode.OTP_INVALID]: 'errors.biz.otpInvalid',
  [BusinessCode.OTP_EXPIRED]: 'errors.biz.otpExpired',
  [BusinessCode.OTP_CONSUMED]: 'errors.biz.otpConsumed',
  [BusinessCode.QR_INVALID]: 'errors.biz.qrInvalid',
  [BusinessCode.QR_EXPIRED]: 'errors.biz.qrExpired',
  [BusinessCode.PASSWORD_NOT_SET]: 'errors.biz.passwordNotSet',
  [BusinessCode.MUST_CHANGE_PASSWORD]: 'errors.biz.mustChangePassword',
  [BusinessCode.INTERNAL]: 'errors.biz.internal',
  [BusinessCode.FRIEND_SELF]: 'friend.error.canNotAddSelf',
  [BusinessCode.FRIEND_NOT_FOUND]: 'errors.biz.notFriends',
  [BusinessCode.INVITE_NOT_FOUND]: 'errors.biz.inviteNotFound',
  [BusinessCode.INVITE_EXPIRED]: 'errors.biz.inviteExpired',
  [BusinessCode.INVITE_NOT_YOURS]: 'errors.biz.inviteNotYours',
  [BusinessCode.INVITE_ALREADY_HANDLED]: 'errors.biz.inviteAlreadyHandled',
  [BusinessCode.MESSAGE_EMPTY]: 'errors.biz.messageEmpty',
  [BusinessCode.THREAD_NOT_APPROVED]: 'errors.biz.threadNotApproved',
  [BusinessCode.THREAD_NOT_FOUND]: 'errors.biz.threadNotFound',
  [BusinessCode.GROUP_INVALID_TOKEN]: 'errors.biz.groupInvalidToken',
  [BusinessCode.GROUP_OWNER_MUST_TRANSFER]: 'group.leaveOwnerNote',
  [BusinessCode.GROUP_FORBIDDEN]: 'errors.biz.groupForbidden',
  [BusinessCode.GROUP_TARGET_NOT_MEMBER]: 'errors.biz.groupTargetNotMember',
  [BusinessCode.GROUP_DISSOLVED]: 'errors.biz.groupDissolved',
  [BusinessCode.GROUP_FULL]: 'errors.biz.groupFull',
  [BusinessCode.FEDERATION_DELIVERY_FAILED]:
    'errors.biz.federationDeliveryFailed',
  [BusinessCode.FEDERATION_QUOTA_EXCEEDED]:
    'errors.biz.federationQuotaExceeded',
  [BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE]:
    'errors.biz.federationPayloadTooLarge',
  [BusinessCode.FEDERATION_CAPABILITY_DISABLED]:
    'errors.biz.federationCapabilityDisabled',
  [BusinessCode.FEDERATION_NAMESPACE_INACTIVE]:
    'errors.biz.federationNamespaceInactive',
};

/**
 * Resolve a backend response to a localized, user-facing string.
 *
 * Priority: `messageKey` (backend-supplied i18n key, for code-0 disambiguation) → numeric `code` map
 * (every known business error) → raw English `message` (unknown codes / unmapped backends). The last
 * fallback is intentional: an unmapped code is still better than a blank, and surfaces the gap so the
 * map can be extended.
 */
export function translateBizResult<T>(
  res: StandardResponse<T>,
  transloco: TranslocoService,
): string {
  if (res.messageKey) return transloco.translate(res.messageKey);
  const key = BIZ_CODE_KEY[res.code];
  return key ? transloco.translate(key) : res.message;
}
