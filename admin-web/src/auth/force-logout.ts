import { clearTokens } from './token-store'

/**
 * 强制登出：清 token + 跳登录页。
 * 用于 refresh 重用(10006)/refresh 失败等异常路径——在 fetch 层触发，
 * 不在 React 树内，故用 window.location 而非 useNavigate（整页刷新在此场景可接受）。
 */
export function forceLogout(): void {
  clearTokens()
  if (typeof window !== 'undefined' && !window.location.pathname.endsWith('/login')) {
    window.location.assign('/login')
  }
}
