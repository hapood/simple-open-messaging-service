import { API_BASE, CODE } from '@/lib/constants'
import { ApiError } from '@/lib/api-error'
import { getAccessToken, getRefreshToken } from '@/auth/token-store'
import type { ApiResult, TokenPair } from '@/types/api'

/**
 * 公开 POST（不注入 Bearer、不触发 401 重试）：login / renew-access 用。
 * 解 ApiResult 信封，code !== 0 抛 ApiError。
 */
async function postPublic<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: ApiResult<T> = await res
    .json()
    .catch(() => ({ code: -1, message: '响应解析失败' }) as ApiResult<T>)
  if (json.code !== CODE.OK) throw new ApiError(json.code, json.message, res.status)
  return json.data as T
}

/** 管理员登录（公开） */
export function adminLogin(username: string, password: string): Promise<TokenPair> {
  return postPublic<TokenPair>('/admin/login', { username, password })
}

/**
 * refresh 轮换（公开）。失败（10006 重用 / 10003 无效|过期）抛 ApiError，
 * 由 refresh-singleton 捕获后 forceLogout。
 */
export function renewAccess(refreshToken: string): Promise<TokenPair> {
  return postPublic<TokenPair>('/admin/renew-access', { refreshToken })
}

/**
 * 管理员登出（需 Bearer）。用原生 fetch 手动注入 token，
 * 不走 client.request，避免与 refresh 链路形成模块循环依赖。失败不阻塞本地清理。
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
    /* 登出请求失败不阻塞本地清理 */
  }
}
