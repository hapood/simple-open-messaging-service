import i18n from '@/i18n'
import { API_BASE, CODE } from '@/lib/constants'
import { ApiError } from '@/lib/api-error'
import { getAccessToken, getRefreshToken } from '@/auth/token-store'
import type { ApiResult, TokenPair } from '@/types/api'

/**
 * Public POST (no Bearer injected, no 401 retry): used by login / renew-access.
 * Unwraps the ApiResult envelope; throws ApiError when code !== 0.
 */
async function postPublic<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: ApiResult<T> = await res
    .json()
    .catch(() => ({ code: -1, message: i18n.t('errors.parseFailed') }) as ApiResult<T>)
  if (json.code !== CODE.OK) throw new ApiError(json.code, json.message, res.status)
  return json.data as T
}

/** Admin login (public). */
export function adminLogin(username: string, password: string): Promise<TokenPair> {
  return postPublic<TokenPair>('/admin/login', { username, password })
}

/**
 * Refresh rotation (public). Failure (10006 reuse / 10003 invalid|expired) throws
 * ApiError, caught by refresh-singleton which then forceLogout.
 */
export function renewAccess(refreshToken: string): Promise<TokenPair> {
  return postPublic<TokenPair>('/admin/renew-access', { refreshToken })
}

/**
 * Admin logout (requires Bearer). Uses a raw fetch with manual token injection and
 * does not go through client.request, to avoid a module cycle with the refresh
 * chain. Failure does not block local cleanup.
 */
export async function adminLogout(): Promise<void> {
  const rt = getRefreshToken()
  const at = getAccessToken()
  if (!rt) return
  try {
    await fetch(`${API_BASE}/admin/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(at ? { Authorization: `Bearer ${at}` } : {}),
      },
      body: JSON.stringify({ refreshToken: rt }),
    })
  } catch {
    /* Logout request failure does not block local cleanup. */
  }
}
