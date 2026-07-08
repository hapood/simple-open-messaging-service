import { Navigate, Outlet } from 'react-router-dom'
import { AdminLayout } from '@/components/layout/admin-layout'
import { getRefreshToken } from '@/auth/token-store'

/**
 * Protected route: no refresh token → redirect to /login.
 * Refresh present but access expired/invalid → the API client transparently refreshes
 * on the first 401; if refresh also fails → forceLogout redirects to /login.
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
