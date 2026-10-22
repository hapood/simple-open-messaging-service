import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { RouteTabs } from '@/components/common/route-tabs'

/** Users hub shell: a shared title above route-driven tabs (Users | Operators). Each tab is its own
 *  route rendered through <Outlet/>, so the two list pages keep independent search/pagination URL
 *  state. The individual account tables live in users-page / admins-page. */
export function UsersLayout() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('users.title')}</h1>
      <RouteTabs
        tabs={[
          { to: '/users', label: t('users.tabs.users') },
          { to: '/users/operators', label: t('users.tabs.operators') },
        ]}
      />
      <Outlet />
    </div>
  )
}
