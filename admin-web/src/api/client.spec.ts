import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// force-logout does window.location.assign → jsdom throws "Not implemented: navigation"; stub it so the
// 401 path can be asserted without a real navigation.
vi.mock('@/auth/force-logout', () => ({ forceLogout: vi.fn() }))

import { request, rateLimitConfig } from './client'
import { ApiError } from '@/lib/api-error'
import { CODE } from '@/lib/constants'
import { forceLogout } from '@/auth/force-logout'

/** A minimal Response stub: status + a JSON body resolved by res.json(). */
function res(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

/**
 * request() now retries the ThrottleGuard burst rate-limit (429 / code 10005) with full-jitter backoff.
 * These pin: success (1 fetch); 429×N→200 (retried, succeeds); 429 exhausted (throws after max retries);
 * 5xx NOT retried (side-effect unknown); 401 force-logouts without retry; public/login 429 NOT retried
 * (the form surfaces it immediately instead of hanging). The backoff delays are zeroed (rateLimitConfig)
 * so the loop runs in real time at ~0ms per retry.
 */
describe('admin-web api/client request()', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(forceLogout).mockClear()
    // Zero the backoff so retries are ~instant under real timers (no fake-timer/microtask driving needed).
    rateLimitConfig.baseMs = 0
    rateLimitConfig.capMs = 0
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rateLimitConfig.baseMs = 1000
    rateLimitConfig.capMs = 8000
  })

  it('returns data on success (single fetch)', async () => {
    fetchMock.mockResolvedValue(res(200, { code: CODE.OK, message: 'ok', data: { a: 1 } }))
    await expect(request('/admin/users')).resolves.toEqual({ a: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 429 burst rate-limit with backoff and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(res(429, { code: CODE.RATE_LIMITED, message: 'too many requests' }))
      .mockResolvedValueOnce(res(429, { code: CODE.RATE_LIMITED, message: 'too many requests' }))
      .mockResolvedValueOnce(res(200, { code: CODE.OK, message: 'ok', data: { ok: true } }))

    await expect(request('/admin/users')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('gives up after the max retries and throws ApiError(10005, 429)', async () => {
    fetchMock.mockResolvedValue(res(429, { code: CODE.RATE_LIMITED, message: 'too many requests' }))

    const err = (await request('/admin/users').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe(CODE.RATE_LIMITED)
    expect(err.httpStatus).toBe(429)
    // 1 initial attempt + 4 retries (rateLimitConfig.maxRetries) = 5 fetches total.
    expect(fetchMock).toHaveBeenCalledTimes(1 + rateLimitConfig.maxRetries)
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
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
