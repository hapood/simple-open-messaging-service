import i18n from '@/i18n'
import { API_BASE, CODE } from '@/lib/constants'
import { ApiError } from '@/lib/api-error'
import type { ApiResult, Authenticated, ChallengeRequired, WebAuthnLoginBegin } from '@/types/api'

/** Admin login outcome: a session token pair, or a 2FA challenge (password verified, awaiting the code). */
export type AdminLoginResult = Authenticated | ChallengeRequired

/**
 * Public credentialed POST used by the login and challenge-verification steps.
 * Unwraps the ApiResult envelope; throws ApiError when code !== 0.
 */
async function postPublic<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: ApiResult<T> = await res
    .json()
    .catch(() => ({ code: -1, message: i18n.t('errors.parseFailed') }) as ApiResult<T>)
  if (json.code !== CODE.OK) throw new ApiError(json.code, json.message, res.status)
  return json.data as T
}

/** Admin login (public). Returns the token pair, or a 2FA challenge when the account is enrolled. */
export function adminLogin(account: string, password: string): Promise<AdminLoginResult> {
  return postPublic<AdminLoginResult>('/admin/login', { account, password })
}

/** Admin 2FA login verify (public) — completes login with a TOTP or backup code after the challenge. */
export function adminLoginVerify(
  challengeToken: string,
  code?: string,
  backupCode?: string,
): Promise<Authenticated> {
  return postPublic<Authenticated>('/admin/login/verify', { challengeToken, code, backupCode })
}

/** Admin passkey login begin (public) — returns assertion options + a pending token for the challenge. */
export function webAuthnLoginBegin(challengeToken: string): Promise<WebAuthnLoginBegin> {
  return postPublic<WebAuthnLoginBegin>('/admin/webauthn/login/begin', { challengeToken })
}

/** Admin passkey login finish (public) — verifies the assertion → session token pair. */
export function webAuthnLoginFinish(
  challengeToken: string,
  pendingToken: string,
  assertionResponse: unknown,
): Promise<Authenticated> {
  return postPublic<Authenticated>('/admin/webauthn/login/finish', {
    challengeToken,
    pendingToken,
    assertionResponse,
  })
}

/**
 * Refresh rotation (public). Failure (10006 reuse / 10003 invalid|expired) throws
 * ApiError, caught by refresh-singleton which then forceLogout.
 */
/**
 * Admin logout (requires Bearer). Uses a raw fetch with manual token injection and
 * does not go through client.request, to avoid a module cycle with the refresh
 * chain. Failure does not block local cleanup.
 */
export async function adminLogout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/admin/logout`, {
      method: 'POST',
      credentials: 'same-origin',
    })
  } catch {
    /* Logout request failure does not block local cleanup. */
  }
}
