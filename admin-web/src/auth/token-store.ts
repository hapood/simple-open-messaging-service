import { ADMIN_RT_KEY } from '@/lib/constants'

// The access token lives only in memory (lost on page reload, rebuilt via refresh; mirrors the Angular C-end).
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
