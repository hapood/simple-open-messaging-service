import { Navigate, Outlet } from 'react-router-dom'
import { AdminLayout } from '@/components/layout/admin-layout'
import { getRefreshToken } from '@/auth/token-store'

/**
 * 受保护路由：无 refresh token → 重定向 /login。
 * 有 refresh 但 access 过期/失效 → 由 apiClient 在首个请求 401 时透明 refresh；
 * refresh 也失效 → forceLogout 跳 /login。
 */
export function ProtectedRoute() {
  const rt = getRefreshToken()
  if (!rt) return <Navigate to="/login" replace />
  return (
    <AdminLayout>
      <Outlet />
    </AdminLayout>
  )
}
