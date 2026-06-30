import { renewAccess } from '@/api/auth'
import { forceLogout } from '@/auth/force-logout'
import { getRefreshToken, setAccessToken, setRefreshToken } from '@/auth/token-store'

// 单飞锚点：在飞的 refresh 共享同一个 promise，并发 401 只触发一次 renew-access
let inflight: Promise<boolean> | null = null

/**
 * 单飞 refresh：成功 → 更新 access+refresh（后端轮换 refresh，必须回写存储）；
 * 失败（10006 重用 / 10003 无效|过期）→ forceLogout。finally 清 inflight 释放单飞。
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
