import i18n from '@/i18n'
import { ApiError } from '@/lib/api-error'
import { CODE } from '@/lib/constants'

/**
 * Resolve a backend business code to a localized message via literal t() keys (keeps
 * the call type-safe under i18next's resource augmentation). `code: -1` is a
 * frontend-synthesized code used when the response body cannot be parsed as JSON.
 * Returns null for unmapped codes so the caller can fall back to the backend message.
 */
function localizedBizMessage(code: number): string | null {
  switch (code) {
    case -1:
      return i18n.t('errors.parseFailed')
    case CODE.VALIDATION_FAILED:
      return i18n.t('errors.biz.validation')
    case CODE.NOT_FOUND:
      return i18n.t('errors.biz.notFound')
    case CODE.ALREADY_EXISTS:
      return i18n.t('errors.biz.alreadyExists')
    case CODE.UNAUTHENTICATED:
      return i18n.t('errors.biz.unauthenticated')
    case CODE.INVALID_CREDENTIALS:
      return i18n.t('errors.biz.invalidCredentials')
    case CODE.FORBIDDEN:
      return i18n.t('errors.biz.forbidden')
    case CODE.RATE_LIMITED:
      return i18n.t('errors.biz.rateLimited')
    case CODE.REFRESH_REUSE_DETECTED:
      return i18n.t('errors.biz.refreshReuse')
    case CODE.SESSION_REVOKED:
      return i18n.t('errors.biz.sessionRevoked')
    case CODE.LOGIN_METHOD_DISABLED:
      return i18n.t('errors.biz.loginMethodDisabled')
    case CODE.OTP_INVALID:
      return i18n.t('errors.biz.otpInvalid')
    case CODE.OTP_EXPIRED:
      return i18n.t('errors.biz.otpExpired')
    case CODE.OTP_CONSUMED:
      return i18n.t('errors.biz.otpConsumed')
    case CODE.PASSWORD_NOT_SET:
      return i18n.t('errors.biz.passwordNotSet')
    case CODE.MUST_CHANGE_PASSWORD:
      return i18n.t('errors.biz.mustChangePassword')
    case CODE.TWO_FACTOR_INVALID:
      return i18n.t('errors.biz.twoFactorInvalid')
    case CODE.TWO_FACTOR_CHALLENGE_EXPIRED:
      return i18n.t('errors.biz.twoFactorChallengeExpired')
    case CODE.TWO_FACTOR_NOT_ENABLED:
      return i18n.t('errors.biz.twoFactorNotEnabled')
    case CODE.TWO_FACTOR_ALREADY_ENABLED:
      return i18n.t('errors.biz.twoFactorAlreadyEnabled')
    case CODE.WEBAUTHN_NOT_AVAILABLE:
      return i18n.t('errors.biz.webauthnNotAvailable')
    case CODE.WEBAUTHN_CHALLENGE_EXPIRED:
      return i18n.t('errors.biz.webauthnChallengeExpired')
    case CODE.WEBAUTHN_VERIFICATION_FAILED:
      return i18n.t('errors.biz.webauthnVerificationFailed')
    case CODE.INTERNAL:
      return i18n.t('errors.biz.internal')
    case CODE.VAPID_INVALID:
      return i18n.t('errors.biz.vapidInvalid')
    default:
      return null
  }
}

/**
 * Localize an error for display. Known business codes resolve to a translated string;
 * unmapped ApiErrors fall back to the backend message; anything else becomes a generic
 * "operation failed". Usable outside React (uses the i18n singleton) so query-client
 * and the API layer can share it.
 */
export function formatApiError(err: unknown): string {
  if (err instanceof ApiError) {
    // 5xx is a server-side failure (side-effect state unknown) — surface the actionable "server trouble,
    // retry" message rather than the generic per-code mapping (a 5xx → code 10999 "Something went wrong").
    if (err.httpStatus >= 500) return i18n.t('errors.serverError')
    return localizedBizMessage(err.code) ?? err.message
  }
  return i18n.t('common.operationFailed')
}
