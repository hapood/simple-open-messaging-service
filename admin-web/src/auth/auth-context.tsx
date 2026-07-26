import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminLogin, adminLoginVerify, adminLogout, webAuthnLoginBegin, webAuthnLoginFinish } from '@/api/auth'
import { startAuthentication } from '@simplewebauthn/browser'

/** Password-step outcome: either fully logged in (tokens stored), or a second-factor challenge to resolve
 *  next. `factors` tells the login page which affordances to show (TOTP/backup vs passkey). */
export type LoginStepResult =
  | { done: true }
  | { twoFactorRequired: true; challengeToken: string; factors: { totp: boolean; webauthn: boolean } }

interface AuthContextValue {
  isAuthenticated: boolean
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
  // The access token is in-memory and does not drive re-rendering (a transparent
  // refresh must not trigger UI); a version bump refreshes isAuthenticated only on
  // the discrete login/logout events.
  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((v) => v + 1), [])

  const login = useCallback(async (account: string, password: string): Promise<LoginStepResult> => {
    const data = await adminLogin(account, password)
    if ('twoFactorRequired' in data) {
      // Password verified, but a second factor is required before any session is issued.
      return { twoFactorRequired: true, challengeToken: data.challengeToken, factors: data.factors }
    }
    bump()
    return { done: true }
  }, [bump])

  const verifyTwoFactor = useCallback(
    async (challengeToken: string, code?: string, backupCode?: string) => {
      await adminLoginVerify(challengeToken, code, backupCode)
      bump()
    },
    [bump],
  )

  const verifyPasskey = useCallback(
    async (challengeToken: string) => {
      const begin = await webAuthnLoginBegin(challengeToken)
      // The browser drives the platform authenticator; the backend generated the options.
      const assertion = await startAuthentication({ optionsJSON: begin.options })
      await webAuthnLoginFinish(challengeToken, begin.pendingToken, assertion)
      bump()
    },
    [bump],
  )

  const logout = useCallback(async () => {
    await adminLogout()
    bump()
    navigate('/login', { replace: true })
  }, [bump, navigate])

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: window.location.pathname.endsWith('/login') ? version > 0 : true,
      login,
      verifyTwoFactor,
      verifyPasskey,
      logout,
    }),
    // `version` only exists to recompute isAuthenticated after login/logout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, login, verifyTwoFactor, verifyPasskey, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
