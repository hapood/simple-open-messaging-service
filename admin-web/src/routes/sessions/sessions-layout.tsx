import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { RouteTabs } from '@/components/common/route-tabs'

/** Sessions hub shell: route-driven tabs over the three "who is authenticated right now" views —
 *  user sessions, admin refresh sessions, and refresh-token reuse alerts. Each tab is its own route
 *  (independent URL state) rendered through <Outlet/>. */
export function SessionsLayout() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('sessions.title')}</h1>
      <RouteTabs
        tabs={[
          { to: '/sessions', label: t('sessions.tabs.users') },
          { to: '/sessions/admins', label: t('sessions.tabs.admins') },
          { to: '/sessions/reuse', label: t('sessions.tabs.reuse') },
        ]}
      />
      <Outlet />
    </div>
  )
}
