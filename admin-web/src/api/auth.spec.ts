import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adminLogin,
  adminLoginVerify,
  adminLogout,
  webAuthnLoginBegin,
  webAuthnLoginFinish,
} from './auth'
import { ApiError } from '@/lib/api-error'

const response = (status: number, body: unknown): Response =>
  ({ status, json: async () => body }) as Response

describe('admin auth API', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('uses same-origin credentials for password and TOTP login', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { code: 0, data: { authenticated: true } }))
      .mockResolvedValueOnce(response(200, { code: 0, data: { authenticated: true } }))

    await adminLogin('root', 'secret')
    await adminLoginVerify('challenge', '123456')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/admin/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ account: 'root', password: 'secret' }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/admin/login/verify',
      expect.objectContaining({
        credentials: 'same-origin',
        body: JSON.stringify({
          challengeToken: 'challenge',
          code: '123456',
        }),
      }),
    )
  })

  it('carries both passkey pending tokens through begin and finish', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response(200, {
          code: 0,
          data: { pendingToken: 'pending', options: { challenge: 'abc' } },
        }),
      )
      .mockResolvedValueOnce(response(200, { code: 0, data: { authenticated: true } }))

    await webAuthnLoginBegin('challenge')
    await webAuthnLoginFinish('challenge', 'pending', { id: 'credential' })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      challengeToken: 'challenge',
    })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      challengeToken: 'challenge',
      pendingToken: 'pending',
      assertionResponse: { id: 'credential' },
    })
  })

  it('surfaces a business error from a public login endpoint', async () => {
    fetchMock.mockResolvedValue(
      response(429, { code: 10005, message: 'too many attempts' }),
    )

    const error = await adminLogin('root', 'wrong').catch((value) => value)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 10005, httpStatus: 429 })
  })

  it('attempts server logout with the cookie and tolerates a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))

    await expect(adminLogout()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/logout', {
      method: 'POST',
      credentials: 'same-origin',
    })
  })
})
