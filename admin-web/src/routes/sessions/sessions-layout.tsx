import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RouteTabs } from '@/components/common/route-tabs';

/** Sessions hub shell: route-driven tabs over the "who is authenticated right now" views —
 *  user sessions and admin sessions. Each tab is its own route
 *  (independent URL state) rendered through <Outlet/>. */
export function SessionsLayout() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">
        {t('sessions.title')}
      </h1>
      <RouteTabs
        tabs={[{ to: '/sessions', label: t('sessions.tabs.users') }]}
      />
      <Outlet />
    </div>
  );
}
