import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/auth/auth-context'
import { AdminLayout } from '@/components/layout/admin-layout'

/** Protected route: verify the httpOnly admin session before mounting the console. */
export function ProtectedRoute() {
  const { isAuthenticated, isChecking } = useAuth()

  // Render no console structure until the server has verified the httpOnly session cookie.
  if (isChecking) return null
  if (!isAuthenticated) return <Navigate to="/login" replace />

  return (
    <AdminLayout>
      <Outlet />
    </AdminLayout>
  )
}
