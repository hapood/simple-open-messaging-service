import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// force-logout does window.location.assign → jsdom throws "Not implemented: navigation"; stub it so the
// 401 path can be asserted without a real navigation.
vi.mock('@/auth/force-logout', () => ({ forceLogout: vi.fn() }))

import { request } from './client'
import { ApiError } from '@/lib/api-error'
import { CODE } from '@/lib/constants'
import { forceLogout } from '@/auth/force-logout'

/** A minimal Response stub: status + a JSON body resolved by res.json(). */
function res(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

/**
 * request() does NOT retry rate limits: a 429 may come from a pre-handler guard (ThrottleGuard) or
 * from a handler's own cooldown (self-check, diagnostics) — the client cannot tell them apart, so the
 * error is returned to the caller immediately. These pin: success (1 fetch); 429 throws
 * ApiError(10005) on the first response (no silent backoff); 5xx throws immediately; 401
 * force-logouts without retry; a 429 on public/login paths surfaces the same way.
 */
describe('admin-web api/client request()', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(forceLogout).mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns data on success (single fetch)', async () => {
    fetchMock.mockResolvedValue(res(200, { code: CODE.OK, message: 'ok', data: { a: 1 } }))
    await expect(request('/admin/users')).resolves.toEqual({ a: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws ApiError(10005, 429) immediately on a rate limit — no silent retry/backoff', async () => {
    fetchMock.mockResolvedValue(res(429, { code: CODE.RATE_LIMITED, message: 'too many requests' }))

    const err = (await request('/admin/users').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe(CODE.RATE_LIMITED)
    expect(err.httpStatus).toBe(429)
    // A single fetch — the caller decides how to react; the client neither hammers the limiter
    // nor hides the outcome behind a backoff loop.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a 5xx (side-effect unknown) — throws immediately, single fetch', async () => {
    fetchMock.mockResolvedValue(res(500, { code: CODE.INTERNAL, message: 'boom' }))
    const err = (await request('/admin/users').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe(CODE.INTERNAL)
    expect(err.httpStatus).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('force-logouts on 401 without retrying', async () => {
    fetchMock.mockResolvedValue(res(401, { code: CODE.UNAUTHENTICATED, message: 'no' }))
    await expect(request('/admin/users')).rejects.toBeInstanceOf(ApiError)
    expect(forceLogout).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a 429 on public (login) paths — surfaces immediately', async () => {
    fetchMock.mockResolvedValue(res(429, { code: CODE.RATE_LIMITED, message: 'too many requests' }))
    const err = (await request('/admin/login').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe(CODE.RATE_LIMITED)
    expect(forceLogout).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
