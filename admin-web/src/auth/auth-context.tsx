import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminLogin, adminLogout } from '@/api/auth'
import { clearTokens, getRefreshToken, setAccessToken, setRefreshToken } from '@/auth/token-store'

interface AuthContextValue {
  isAuthenticated: boolean
  /** Login: only stores tokens + bumps state; navigation is controlled by the caller (the login page). */
  login: (username: string, password: string) => Promise<void>
  /** Logout: calls backend revoke + clears tokens + navigates to /login. */
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  // The access token is in-memory and does not drive re-rendering (a transparent
  // refresh must not trigger UI); a version bump refreshes isAuthenticated only on
  // the discrete login/logout events.
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
    // `version` only exists to recompute isAuthenticated after login/logout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
