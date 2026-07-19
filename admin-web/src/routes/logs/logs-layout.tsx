import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { RouteTabs } from '@/components/common/route-tabs'

/** Logs hub shell: route-driven tabs over the three log views — Live tail, rotated-file History
 *  search, and the admin-action Audit log. Each tab is its own route rendered through <Outlet/>. */
export function LogsLayout() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('logs.title')}</h1>
      <RouteTabs
        tabs={[
          { to: '/logs', label: t('logs.tabs.live') },
          { to: '/logs/history', label: t('logs.tabs.history') },
          { to: '/logs/audit', label: t('logs.tabs.audit') },
        ]}
      />
      <Outlet />
    </div>
  )
}
