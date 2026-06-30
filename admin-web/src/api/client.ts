import { API_BASE, CODE } from '@/lib/constants'
import { ApiError } from '@/lib/api-error'
import { forceLogout } from '@/auth/force-logout'
import { refreshOnce } from '@/auth/refresh-singleton'
import { getAccessToken } from '@/auth/token-store'
import type { ApiResult } from '@/types/api'

// 公开白名单：不注入 Bearer、不触发 401 重试（否则 refresh 链路自循环）
const PUBLIC_PATHS = ['/admin/login', '/admin/renew-access']

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path.endsWith(p))
}

function authHeader(): Record<string, string> {
  const at = getAccessToken()
  return at ? { Authorization: `Bearer ${at}` } : {}
}

/**
 * 统一请求：注入 Bearer、解 ApiResult 信封、401 或 10003 → 单飞 refresh → 重试一次。
 * 10006（重用）→ forceLogout。公开请求不参与重试。供各业务 API 函数调用。
 */
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const publicReq = isPublic(path)
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(publicReq ? {} : authHeader()),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json: ApiResult<T> = await res
    .json()
    .catch(() => ({ code: -1, message: '响应解析失败' }) as ApiResult<T>)

  // 受保护请求遇 401（后端 AdminAuthGuard 真返 401）或业务码 10003 → 透明 refresh + 重试一次
  if (!publicReq && (res.status === 401 || json.code === CODE.UNAUTHENTICATED)) {
    const ok = await refreshOnce()
    if (!ok) throw new ApiError(CODE.UNAUTHENTICATED, '未认证', res.status)
    return request<T>(path, body)
  }

  // 防御性：任何路径拿到 10006 都强登出
  if (json.code === CODE.REFRESH_REUSE_DETECTED) {
    forceLogout()
    throw new ApiError(CODE.REFRESH_REUSE_DETECTED, json.message, res.status)
  }

  if (json.code !== CODE.OK) {
    throw new ApiError(json.code, json.message, res.status)
  }
  return json.data as T
}
