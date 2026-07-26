import i18n from '@/i18n'
import { API_BASE, CODE } from '@/lib/constants'
import { ApiError } from '@/lib/api-error'
import { forceLogout } from '@/auth/force-logout'
import type { ApiResult } from '@/types/api'

// Public allowlist: no Bearer injected, no 401 retry (otherwise the refresh chain self-loops).
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
 * Unified request: injects Bearer, unwraps the ApiResult envelope, and on 401 or
 * business code 10003 performs a single-flight refresh then retries once.
 * 10006 (reuse) → forceLogout. Public requests do not participate in retry.
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
 * Public GET (e.g. GET /config) — no Bearer injected, no 401/refresh retry, no body.
 * Unwraps the same ApiResult envelope as {@link request}. Public reads are not part of
 * the admin auth chain, so they never trigger a refresh cycle.
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
