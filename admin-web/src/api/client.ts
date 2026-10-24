import i18n from '@/i18n'
import { API_BASE, CODE } from '@/lib/constants'
import { ApiError } from '@/lib/api-error'
import { forceLogout } from '@/auth/force-logout'
import type { ApiResult } from '@/types/api'

// Public allowlist: login + 2FA challenge steps bypass the 401 → forceLogout handling below, so an
// unauthenticated response to these doesn't bounce back to /login and self-loop.
const PUBLIC_PATHS = [
  '/admin/login',
  '/admin/login/verify',
  '/admin/webauthn/login/begin',
  '/admin/webauthn/login/finish',
]

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path.endsWith(p))
}

/**
 * Unified request: the httpOnly `admin_session` cookie is the credential (auto-attached same-origin
 * via credentials:'same-origin'; there is no Bearer header and no refresh step). Unwraps the ApiResult
 * envelope; on 401 / code 10003 (unauthenticated) or 10006 (reuse) it force-logs-out and throws.
 * Public requests (login + challenge steps) bypass that so an unauthenticated response there doesn't
 * loop back to /login.
 *
 * Rate limits (429 / code 10005) are NOT retried and are returned to the caller immediately. A 429
 * may come from a pre-handler guard (ThrottleGuard burst limit) OR from a handler's own deliberate
 * cooldown (federation self-check, diagnostics report window, push probe) — the client cannot tell
 * them apart, so silently retrying would hammer the limiter, hide the outcome for seconds, and
 * potentially re-trigger handler work. Callers surface it via formatApiError() (localized
 * "too many requests"); if the limiter is meant to be honored programmatically, the endpoint should
 * provide Retry-After rather than the client guessing.
 */
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const publicReq = isPublic(path)
  // Do not declare Content-Type when there is no body: Fastify raises
  // FST_ERR_CTP_BODY_CANNOT_BE_EMPTY when it sees content-type: application/json
  // with an empty body. The presence of a body must match the content-type claim.
  const hasBody = body !== undefined
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  })
  const json: ApiResult<T> = await res
    .json()
    .catch(() => ({ code: -1, message: i18n.t('errors.parseFailed') }) as ApiResult<T>)

  if (!publicReq && (res.status === 401 || json.code === CODE.UNAUTHENTICATED)) {
    forceLogout()
    throw new ApiError(CODE.UNAUTHENTICATED, i18n.t('errors.unauthenticated'), res.status)
  }

  // Defensive: any path receiving 10006 forces logout.
  if (json.code === CODE.REFRESH_REUSE_DETECTED) {
    forceLogout()
    throw new ApiError(CODE.REFRESH_REUSE_DETECTED, json.message, res.status)
  }

  if (json.code !== CODE.OK) {
    throw new ApiError(json.code, json.message, res.status)
  }
  return json.data as T
}

/**
 * Public GET (e.g. GET /config) — no body, and no 401 → forceLogout handling (public reads are not
 * part of the admin session chain). Unwraps the same ApiResult envelope as {@link request}.
 */
export async function requestGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'GET', credentials: 'same-origin' })
  const json: ApiResult<T> = await res
    .json()
    .catch(() => ({ code: -1, message: i18n.t('errors.parseFailed') }) as ApiResult<T>)
  if (json.code !== CODE.OK) {
    throw new ApiError(json.code, json.message, res.status)
  }
  return json.data as T
}
