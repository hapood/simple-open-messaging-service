import { renewAccess } from '@/api/auth'
import { forceLogout } from '@/auth/force-logout'
import { getRefreshToken, setAccessToken, setRefreshToken } from '@/auth/token-store'

// Single-flight anchor: an in-flight refresh is shared as one promise, so concurrent
// 401s trigger renew-access only once.
let inflight: Promise<boolean> | null = null

/**
 * Single-flight refresh: on success → update access+refresh (the backend rotates the
 * refresh token, so it must be written back to storage); on failure (10006 reuse /
 * 10003 invalid|expired) → forceLogout. The finally block clears `inflight` to release
 * the single-flight slot.
 */
export function refreshOnce(): Promise<boolean> {
  if (inflight) return inflight
  inflight = (async () => {
    const rt = getRefreshToken()
    if (!rt) {
      forceLogout()
      return false
    }
    try {
      const data = await renewAccess(rt)
      setAccessToken(data.access_token)
      setRefreshToken(data.refresh_token)
      return true
    } catch {
      forceLogout()
      return false
    } finally {
      inflight = null
    }
  })()
  return inflight
}
