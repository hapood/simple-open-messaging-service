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
    case CODE.UNAUTHENTICATED:
      return i18n.t('errors.biz.unauthenticated')
    case CODE.FORBIDDEN:
      return i18n.t('errors.biz.forbidden')
    case CODE.RATE_LIMITED:
      return i18n.t('errors.biz.rateLimited')
    case CODE.REFRESH_REUSE_DETECTED:
      return i18n.t('errors.biz.refreshReuse')
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
    return localizedBizMessage(err.code) ?? err.message
  }
  return i18n.t('common.operationFailed')
}
