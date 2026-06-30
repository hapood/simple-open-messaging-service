import { ADMIN_RT_KEY } from '@/lib/constants'

// access token 仅存内存（刷新页即失，靠 refresh 重建；与 Angular C 端一致）
let accessToken: string | null = null

export const getAccessToken = (): string | null => accessToken

export const setAccessToken = (t: string | null): void => {
  accessToken = t
}

export const getRefreshToken = (): string | null => {
  try {
    return localStorage.getItem(ADMIN_RT_KEY)
  } catch {
    return null
  }
}

export const setRefreshToken = (t: string): void => {
  try {
    localStorage.setItem(ADMIN_RT_KEY, t)
  } catch {
    /* ignore quota errors */
  }
}

export const clearTokens = (): void => {
  accessToken = null
  try {
    localStorage.removeItem(ADMIN_RT_KEY)
  } catch {
    /* ignore */
  }
}
