import { Navigate, Outlet, createBrowserRouter } from 'react-router-dom';
import { AuthProvider } from '@/auth/auth-context';
import { ProtectedRoute } from '@/components/route/protected-route';
import { LoginPage } from '@/routes/login/login-page';
import { NotFoundPage } from '@/routes/not-found-page';
import { RouteErrorPage } from '@/routes/route-error-page';
import { UsersLayout } from '@/routes/users/users-layout';
import { SessionsLayout } from '@/routes/sessions/sessions-layout';
import { FederationLayout } from '@/routes/federation/federation-layout';
import { PushLayout } from '@/routes/push/push-layout';
import { LogsLayout } from '@/routes/logs/logs-layout';

/**
 * Each non-entry page is a react-router v7 `lazy` route: the page module is a separate chunk fetched
 * on first navigation. This keeps the initial bundle to React + router + query + auth + login rather
 * than the whole admin console (20+ pages, incl. heavy logs/federation/media/push surfaces), so a user
 * signing in downloads dashboard + one page instead of all of them up front.
 *
 * `lazy` returns `{ Component }` (it may also return `loader`/`action`/`ErrorBoundary`); the route's
 * `element` must be omitted when `lazy` is used. The layout routes (RootLayout, ProtectedRoute, and
 * the five hub layouts — Users/Sessions/Federation/Push/Logs) stay eager: they are tiny <Outlet/>
 * wrappers that must render before any lazy child resolves.
 *
 * Multi-tab hubs use route-driven tabs: a hub layout (e.g. UsersLayout) renders the title + tab bar
 * and an <Outlet/>, with the tabs as child routes (the index route + named sub-routes). Detail pages
 * (/users/:id, /federation/:domain) are full-page siblings outside the hub layout. react-router v7
 * ranks static segments ahead of dynamic ones, so /users/operators and /federation/self-check resolve
 * to their hub children rather than to the :id / :domain siblings.
 *
 */

/** Root layout: AuthProvider must sit inside RouterProvider so login/logout can use useNavigate. */
function RootLayout() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

export const router = createBrowserRouter(
  [
    {
      element: <RootLayout />,
      errorElement: <RouteErrorPage />,
      children: [
        { path: '/login', element: <LoginPage /> },
        {
          element: <ProtectedRoute />,
          children: [
            { path: '/', element: <Navigate to="/dashboard" replace /> },
            {
              path: '/dashboard',
              lazy: () =>
                import('@/routes/dashboard/dashboard-page').then((m) => ({
                  Component: m.DashboardPage,
                })),
            },
            {
              path: '/users',
              element: <UsersLayout />,
              children: [
                {
                  index: true,
                  lazy: () =>
                    import('@/routes/users/users-page').then((m) => ({
                      Component: m.UsersPage,
                    })),
                },
                {
                  path: 'operators',
                  lazy: () =>
                    import('@/routes/admins/admins-page').then((m) => ({
                      Component: m.AdminsPage,
                    })),
                },
              ],
            },
            {
              path: '/users/:id',
              lazy: () =>
                import('@/routes/users/user-detail-page').then((m) => ({
                  Component: m.UserDetailPage,
                })),
            },
            {
              path: '/groups',
              lazy: () =>
                import('@/routes/groups/groups-page').then((m) => ({
                  Component: m.GroupsPage,
                })),
            },
            {
              path: '/sessions',
              element: <SessionsLayout />,
              children: [
                {
                  index: true,
                  lazy: () =>
                    import('@/routes/sessions/sessions-page').then((m) => ({
                      Component: m.SessionsPage,
                    })),
                },
                {
                  path: 'admins',
                  lazy: () =>
                    import('@/routes/admin-sessions/admin-sessions-page').then(
                      (m) => ({ Component: m.AdminSessionsPage }),
                    ),
                },
                {
                  path: 'reuse',
                  lazy: () =>
                    import('@/routes/reuse/reuse-alerts-page').then((m) => ({
                      Component: m.ReuseAlertsPage,
                    })),
                },
              ],
            },
            {
              path: '/connections',
              lazy: () =>
                import('@/routes/connections/connections-page').then((m) => ({
                  Component: m.ConnectionsPage,
                })),
            },
            {
              path: '/bans',
              lazy: () =>
                import('@/routes/bans/bans-page').then((m) => ({
                  Component: m.BansPage,
                })),
            },
            {
              path: '/federation',
              element: <FederationLayout />,
              children: [
                {
                  index: true,
                  lazy: () =>
                    import('@/routes/federation/federation-page').then((m) => ({
                      Component: m.FederationPage,
                    })),
                },
                {
                  path: 'self-check',
                  lazy: () =>
                    import('@/routes/federation/self-check-page').then((m) => ({
                      Component: m.SelfCheckPage,
                    })),
                },
              ],
            },
            {
              path: '/federation/:domain',
              lazy: () =>
                import('@/routes/federation/peer-detail-page').then((m) => ({
                  Component: m.PeerDetailPage,
                })),
            },
            {
              path: '/push',
              element: <PushLayout />,
              children: [
                {
                  index: true,
                  lazy: () =>
                    import('@/routes/push/push-page').then((m) => ({
                      Component: m.PushPage,
                    })),
                },
                {
                  path: 'config',
                  lazy: () =>
                    import('@/routes/push/transport-config-panel').then(
                      (m) => ({ Component: m.TransportConfigPanel }),
                    ),
                },
              ],
            },
            {
              path: '/media',
              lazy: () =>
                import('@/routes/media/media-page').then((m) => ({
                  Component: m.MediaPage,
                })),
            },
            {
              path: '/link-cards',
              lazy: () =>
                import('@/routes/link-cards/link-card-rules-page').then(
                  (m) => ({
                    Component: m.LinkCardRulesPage,
                  }),
                ),
            },
            {
              path: '/logs',
              element: <LogsLayout />,
              children: [
                {
                  index: true,
                  lazy: () =>
                    import('@/routes/logs/logs-live-page').then((m) => ({
                      Component: m.LogsLivePage,
                    })),
                },
                {
                  path: 'history',
                  lazy: () =>
                    import('@/routes/logs/history-panel').then((m) => ({
                      Component: m.HistoryPanel,
                    })),
                },
                {
                  path: 'diagnostics',
                  lazy: () =>
                    import(
                      '@/routes/diagnostic-reports/diagnostic-reports-page'
                    ).then((m) => ({ Component: m.DiagnosticReportsPage })),
                },
              ],
            },
            {
              path: '/rate-limits',
              lazy: () =>
                import('@/routes/rate-limits/rate-limits-page').then((m) => ({
                  Component: m.RateLimitsPage,
                })),
            },
            {
              path: '/message-reports',
              lazy: () =>
                import('@/routes/message-reports/message-reports-page').then(
                  (m) => ({ Component: m.MessageReportsPage }),
                ),
            },
            {
              path: '/audit',
              lazy: () =>
                import('@/routes/audit/audit-page').then((m) => ({
                  Component: m.AuditPage,
                })),
            },
            {
              path: '/settings',
              lazy: () =>
                import('@/routes/settings/settings-page').then((m) => ({
                  Component: m.SettingsPage,
                })),
            },
            {
              path: '/security',
              lazy: () =>
                import('@/routes/security/security-page').then((m) => ({
                  Component: m.SecurityPage,
                })),
            },
          ],
        },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ],
  {
    basename: import.meta.env.BASE_URL,
  },
);
