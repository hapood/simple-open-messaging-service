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
import { PushPage } from '@/routes/push/push-page'
import { NotFoundPage } from '@/routes/not-found-page'

/** Root layout: AuthProvider must sit inside RouterProvider so login/logout can use useNavigate. */
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
          { path: '/push', element: <PushPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
], {
  basename: import.meta.env.BASE_URL,
})
