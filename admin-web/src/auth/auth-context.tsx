import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminLogin, adminLoginVerify, adminLogout } from '@/api/auth'
import { clearTokens, getRefreshToken, setAccessToken, setRefreshToken } from '@/auth/token-store'

/** Password-step outcome: either fully logged in (tokens stored), or a 2FA challenge to resolve next. */
export type LoginStepResult = { done: true } | { twoFactorRequired: true; challengeToken: string }

interface AuthContextValue {
  isAuthenticated: boolean
  /** Login (password step): stores tokens + bumps state on success, or returns a 2FA challenge. */
  login: (account: string, password: string) => Promise<LoginStepResult>
  /** Verify the 2FA challenge (TOTP or backup code) → stores tokens + bumps state. */
  verifyTwoFactor: (challengeToken: string, code?: string, backupCode?: string) => Promise<void>
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

  const login = useCallback(async (account: string, password: string): Promise<LoginStepResult> => {
    const data = await adminLogin(account, password)
    if ('twoFactorRequired' in data) {
      // Password verified, but a second factor is required before any session is issued.
      return { twoFactorRequired: true, challengeToken: data.challengeToken }
    }
    setAccessToken(data.access_token)
    setRefreshToken(data.refresh_token)
    bump()
    return { done: true }
  }, [bump])

  const verifyTwoFactor = useCallback(
    async (challengeToken: string, code?: string, backupCode?: string) => {
      const data = await adminLoginVerify(challengeToken, code, backupCode)
      setAccessToken(data.access_token)
      setRefreshToken(data.refresh_token)
      bump()
    },
    [bump],
  )

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
      verifyTwoFactor,
      logout,
    }),
    // `version` only exists to recompute isAuthenticated after login/logout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, login, verifyTwoFactor, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
