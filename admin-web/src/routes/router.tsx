import { Navigate, Outlet, createBrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@/auth/auth-context'
import { ProtectedRoute } from '@/components/route/protected-route'
import { LoginPage } from '@/routes/login/login-page'
import { NotFoundPage } from '@/routes/not-found-page'

/**
 * Each non-entry page is a react-router v7 `lazy` route: the page module is a separate chunk fetched
 * on first navigation. This keeps the initial bundle to React + router + query + auth + login rather
 * than the whole admin console (20+ pages, incl. heavy logs/federation/media/push surfaces), so a user
 * signing in downloads dashboard + one page instead of all of them up front.
 *
 * `lazy` returns `{ Component }` (it may also return `loader`/`action`/`ErrorBoundary`); the route's
 * `element` must be omitted when `lazy` is used. The layout routes (RootLayout, ProtectedRoute) stay
 * eager — they are tiny <Outlet/> wrappers that must render before any lazy child resolves.
 */

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
          {
            path: '/dashboard',
            lazy: () => import('@/routes/dashboard/dashboard-page').then((m) => ({ Component: m.DashboardPage })),
          },
          {
            path: '/users',
            lazy: () => import('@/routes/users/users-page').then((m) => ({ Component: m.UsersPage })),
          },
          {
            path: '/users/:id',
            lazy: () => import('@/routes/users/user-detail-page').then((m) => ({ Component: m.UserDetailPage })),
          },
          {
            path: '/groups',
            lazy: () => import('@/routes/groups/groups-page').then((m) => ({ Component: m.GroupsPage })),
          },
          {
            path: '/sessions',
            lazy: () => import('@/routes/sessions/sessions-page').then((m) => ({ Component: m.SessionsPage })),
          },
          {
            path: '/connections',
            lazy: () => import('@/routes/connections/connections-page').then((m) => ({ Component: m.ConnectionsPage })),
          },
          {
            path: '/admin-sessions',
            lazy: () => import('@/routes/admin-sessions/admin-sessions-page').then((m) => ({ Component: m.AdminSessionsPage })),
          },
          {
            path: '/bans',
            lazy: () => import('@/routes/bans/bans-page').then((m) => ({ Component: m.BansPage })),
          },
          {
            path: '/reuse',
            lazy: () => import('@/routes/reuse/reuse-alerts-page').then((m) => ({ Component: m.ReuseAlertsPage })),
          },
          {
            path: '/push',
            lazy: () => import('@/routes/push/push-page').then((m) => ({ Component: m.PushPage })),
          },
          {
            path: '/federation',
            lazy: () => import('@/routes/federation/federation-page').then((m) => ({ Component: m.FederationPage })),
          },
          {
            path: '/federation/self-check',
            lazy: () => import('@/routes/federation/self-check-page').then((m) => ({ Component: m.SelfCheckPage })),
          },
          {
            path: '/federation/:domain',
            lazy: () => import('@/routes/federation/peer-detail-page').then((m) => ({ Component: m.PeerDetailPage })),
          },
          {
            path: '/logs',
            lazy: () => import('@/routes/logs/logs-page').then((m) => ({ Component: m.LogsPage })),
          },
          {
            path: '/audit',
            lazy: () => import('@/routes/audit/audit-page').then((m) => ({ Component: m.AuditPage })),
          },
          {
            path: '/media',
            lazy: () => import('@/routes/media/media-page').then((m) => ({ Component: m.MediaPage })),
          },
          {
            path: '/admins',
            lazy: () => import('@/routes/admins/admins-page').then((m) => ({ Component: m.AdminsPage })),
          },
          {
            path: '/settings',
            lazy: () => import('@/routes/settings/settings-page').then((m) => ({ Component: m.SettingsPage })),
          },
          {
            path: '/quotas',
            lazy: () => import('@/routes/quotas/quotas-page').then((m) => ({ Component: m.QuotasPage })),
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
], {
  basename: import.meta.env.BASE_URL,
})
