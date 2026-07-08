import { clearTokens } from './token-store'

/**
 * Force logout: clear tokens + navigate to the login page.
 * Used on abnormal paths such as refresh reuse (10006) / refresh failure — triggered
 * from the fetch layer, outside the React tree, so it uses window.location instead of
 * useNavigate (a full page reload is acceptable in this scenario).
 */
export function forceLogout(): void {
  clearTokens()
  if (typeof window !== 'undefined' && !window.location.pathname.endsWith('/login')) {
    window.location.assign('/login')
  }
}
