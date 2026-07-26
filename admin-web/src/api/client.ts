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

// Burst rate-limit retry. A 429 here comes from ThrottleGuard (src/auth/throttle.guard.ts), a Nest GUARD
// that runs BEFORE the handler — so the request never reached the route, NO side effect occurred, and
// retrying is safe even for a non-idempotent POST (the codebase is almost all POST and can't otherwise
// tell reads from mutations). Full-jitter exponential backoff mirrors hooks/use-log-stream.ts; bounded so
// a sustained over-limit surfaces after ~8s avg instead of hanging. Login/challenge (public) paths opt out
// so a throttled login surfaces immediately rather than silently hanging the form.
// Burst rate-limit retry config (full-jitter exp backoff). Exposed so tests can zero the delays — the
// retry loop is otherwise real-time, which would make the retry specs impractically slow.
export const rateLimitConfig = {
  baseMs: 1000,
  capMs: 8000,
  maxRetries: 4,
}

function rateLimitBackoff(retry: number): number {
  const ceil = Math.min(rateLimitConfig.baseMs * 2 ** retry, rateLimitConfig.capMs)
  return Math.random() * ceil
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Unified request: the httpOnly `admin_session` cookie is the credential (auto-attached same-origin
 * via credentials:'same-origin'; there is no Bearer header and no refresh step). Unwraps the ApiResult
 * envelope; on 401 / code 10003 (unauthenticated) or 10006 (reuse) it force-logs-out and throws.
 * Public requests (login + challenge steps) bypass that so an unauthenticated response there doesn't
 * loop back to /login. A 429 burst rate-limit is retried with backoff (see above).
 */
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const publicReq = isPublic(path)
  // Do not declare Content-Type when there is no body: Fastify raises
  // FST_ERR_CTP_BODY_CANNOT_BE_EMPTY when it sees content-type: application/json
  // with an empty body. The presence of a body must match the content-type claim.
  const hasBody = body !== undefined
  const doFetch = (): Promise<Response> =>
    fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(body) : undefined,
    })

  let res!: Response
  let json!: ApiResult<T>
  for (let retry = 0; ; retry++) {
    res = await doFetch()
    json = await res
      .json()
      .catch(() => ({ code: -1, message: i18n.t('errors.parseFailed') }) as ApiResult<T>)
    const rateLimited = res.status === 429 || json.code === CODE.RATE_LIMITED
    if (!rateLimited || publicReq || retry >= rateLimitConfig.maxRetries) break
    await sleep(rateLimitBackoff(retry))
  }

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
