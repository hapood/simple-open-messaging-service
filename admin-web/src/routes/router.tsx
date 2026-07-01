import { Navigate, Outlet, createBrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@/auth/auth-context'
import { ProtectedRoute } from '@/components/route/protected-route'
import { LoginPage } from '@/routes/login/login-page'
import { UsersPage } from '@/routes/users/users-page'
import { SessionsPage } from '@/routes/sessions/sessions-page'
import { ConnectionsPage } from '@/routes/connections/connections-page'
import { AdminSessionsPage } from '@/routes/admin-sessions/admin-sessions-page'
import { BansPage } from '@/routes/bans/bans-page'
import { ReuseAlertsPage } from '@/routes/reuse/reuse-alerts-page'
import { NotFoundPage } from '@/routes/not-found-page'

/** 根 layout：AuthProvider 必须在 RouterProvider 内，login/logout 的 useNavigate 才可用 */
function RootLayout() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  )
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        element: <ProtectedRoute />,
        children: [
          { path: '/', element: <Navigate to="/users" replace /> },
          { path: '/users', element: <UsersPage /> },
          { path: '/sessions', element: <SessionsPage /> },
          { path: '/connections', element: <ConnectionsPage /> },
          { path: '/admin-sessions', element: <AdminSessionsPage /> },
          { path: '/bans', element: <BansPage /> },
          { path: '/reuse', element: <ReuseAlertsPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
], {
  basename: import.meta.env.BASE_URL,
})
