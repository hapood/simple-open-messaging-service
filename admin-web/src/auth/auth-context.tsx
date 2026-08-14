import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { adminLogin, adminLoginVerify, adminLogout, webAuthnLoginBegin, webAuthnLoginFinish } from '@/api/auth'
import { startAuthentication } from '@simplewebauthn/browser'
import { getMe } from '@/api/me'
import { queryClient } from '@/lib/query-client'

/** Password-step outcome: either fully logged in (tokens stored), or a second-factor challenge to resolve
 *  next. `factors` tells the login page which affordances to show (TOTP/backup vs passkey). */
export type LoginStepResult =
  | { done: true }
  | { twoFactorRequired: true; challengeToken: string; factors: { totp: boolean; webauthn: boolean } }

interface AuthContextValue {
  isAuthenticated: boolean
  /** True while the existing httpOnly session is being verified on initial navigation. */
  isChecking: boolean
  /** Login (password step): stores tokens + bumps state on success, or returns a second-factor challenge. */
  login: (account: string, password: string) => Promise<LoginStepResult>
  /** Verify the challenge with a TOTP or backup code → stores tokens + bumps state. */
  verifyTwoFactor: (challengeToken: string, code?: string, backupCode?: string) => Promise<void>
  /** Verify the challenge with a passkey (assertion) → stores tokens + bumps state. */
  verifyPasskey: (challengeToken: string) => Promise<void>
  /** Logout: calls backend revoke + clears tokens + navigates to /login. */
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const onLoginPage = pathname.endsWith('/login')
  const [authState, setAuthState] = useState<'checking' | 'authenticated' | 'unauthenticated'>(
    onLoginPage ? 'unauthenticated' : 'checking',
  )

  // The session cookie is httpOnly, so the browser cannot inspect it locally. Verify it before
  // mounting any protected layout; otherwise the real console flashes until its first API call
  // discovers the expired/missing session and redirects.
  useEffect(() => {
    if (onLoginPage || authState !== 'checking') return
    let active = true
    void queryClient
      .fetchQuery({ queryKey: ['admin', 'me'], queryFn: () => getMe() })
      .then(() => {
        if (active) setAuthState('authenticated')
      })
      .catch(() => {
        if (active) setAuthState('unauthenticated')
      })
    return () => {
      active = false
    }
  }, [authState, onLoginPage])

  const login = useCallback(async (account: string, password: string): Promise<LoginStepResult> => {
    const data = await adminLogin(account, password)
    if ('twoFactorRequired' in data) {
      // Password verified, but a second factor is required before any session is issued.
      return { twoFactorRequired: true, challengeToken: data.challengeToken, factors: data.factors }
    }
    setAuthState('authenticated')
    return { done: true }
  }, [])

  const verifyTwoFactor = useCallback(
    async (challengeToken: string, code?: string, backupCode?: string) => {
      await adminLoginVerify(challengeToken, code, backupCode)
      setAuthState('authenticated')
    },
    [],
  )

  const verifyPasskey = useCallback(
    async (challengeToken: string) => {
      const begin = await webAuthnLoginBegin(challengeToken)
      // The browser drives the platform authenticator; the backend generated the options.
      const assertion = await startAuthentication({ optionsJSON: begin.options })
      await webAuthnLoginFinish(challengeToken, begin.pendingToken, assertion)
      setAuthState('authenticated')
    },
    [],
  )

  const logout = useCallback(async () => {
    await adminLogout()
    queryClient.removeQueries({ queryKey: ['admin'] })
    setAuthState('unauthenticated')
    navigate('/login', { replace: true })
  }, [navigate])

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: authState === 'authenticated',
      isChecking: authState === 'checking',
      login,
      verifyTwoFactor,
      verifyPasskey,
      logout,
    }),
    [authState, login, verifyTwoFactor, verifyPasskey, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
