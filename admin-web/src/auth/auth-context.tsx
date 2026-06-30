import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminLogin, adminLogout } from '@/api/auth'
import { clearTokens, getRefreshToken, setAccessToken, setRefreshToken } from '@/auth/token-store'

interface AuthContextValue {
  isAuthenticated: boolean
  /** 登录：仅存 token + bump 状态；导航由调用方（登录页）控制 */
  login: (username: string, password: string) => Promise<void>
  /** 登出：调后端吊销 + 清 token + 跳 /login */
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  // access token 是内存态、不驱动重渲染（透明刷新不该触发 UI）；
  // 用 version bump 仅在登入/登出离散事件时刷新 isAuthenticated
  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((v) => v + 1), [])

  const login = useCallback(async (username: string, password: string) => {
    const data = await adminLogin(username, password)
    setAccessToken(data.access_token)
    setRefreshToken(data.refresh_token)
    bump()
  }, [bump])

  const logout = useCallback(async () => {
    await adminLogout()
    clearTokens()
    bump()
    navigate('/login', { replace: true })
  }, [bump, navigate])

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: getRefreshToken() !== null,
      login,
      logout,
    }),
    // version 仅用于在登入/登出后触发 isAuthenticated 重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
