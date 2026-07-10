import { Navigate, Outlet, createBrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@/auth/auth-context'
import { ProtectedRoute } from '@/components/route/protected-route'
import { LoginPage } from '@/routes/login/login-page'
import { DashboardPage } from '@/routes/dashboard/dashboard-page'
import { UsersPage } from '@/routes/users/users-page'
import { UserDetailPage } from '@/routes/users/user-detail-page'
import { GroupsPage } from '@/routes/groups/groups-page'
import { SessionsPage } from '@/routes/sessions/sessions-page'
import { ConnectionsPage } from '@/routes/connections/connections-page'
import { AdminSessionsPage } from '@/routes/admin-sessions/admin-sessions-page'
import { BansPage } from '@/routes/bans/bans-page'
import { ReuseAlertsPage } from '@/routes/reuse/reuse-alerts-page'
import { PushPage } from '@/routes/push/push-page'
import { FederationPage } from '@/routes/federation/federation-page'
import { PeerDetailPage } from '@/routes/federation/peer-detail-page'
import { SelfCheckPage } from '@/routes/federation/self-check-page'
import { LogsPage } from '@/routes/logs/logs-page'
import { AuditPage } from '@/routes/audit/audit-page'
import { MediaPage } from '@/routes/media/media-page'
import { AdminsPage } from '@/routes/admins/admins-page'
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
          { path: '/', element: <Navigate to="/dashboard" replace /> },
          { path: '/dashboard', element: <DashboardPage /> },
          { path: '/users', element: <UsersPage /> },
          { path: '/users/:id', element: <UserDetailPage /> },
          { path: '/groups', element: <GroupsPage /> },
          { path: '/sessions', element: <SessionsPage /> },
          { path: '/connections', element: <ConnectionsPage /> },
          { path: '/admin-sessions', element: <AdminSessionsPage /> },
          { path: '/bans', element: <BansPage /> },
          { path: '/reuse', element: <ReuseAlertsPage /> },
          { path: '/push', element: <PushPage /> },
          { path: '/federation', element: <FederationPage /> },
          { path: '/federation/self-check', element: <SelfCheckPage /> },
          { path: '/federation/:domain', element: <PeerDetailPage /> },
          { path: '/logs', element: <LogsPage /> },
          { path: '/audit', element: <AuditPage /> },
          { path: '/media', element: <MediaPage /> },
          { path: '/admins', element: <AdminsPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
], {
  basename: import.meta.env.BASE_URL,
})
