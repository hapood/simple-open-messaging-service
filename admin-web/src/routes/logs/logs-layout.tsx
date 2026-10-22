import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RouteTabs } from '@/components/common/route-tabs';

/** Logs hub shell: runtime logs plus client-submitted diagnostic bundles. Admin action audit records
 *  live under Access & Activity because they are governance data, not runtime logs. */
export function LogsLayout() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">
        {t('logs.title')}
      </h1>
      <RouteTabs
        tabs={[
          { to: '/logs', label: t('logs.tabs.live') },
          { to: '/logs/history', label: t('logs.tabs.history') },
          { to: '/logs/diagnostics', label: t('logs.tabs.diagnostics') },
        ]}
      />
      <Outlet />
    </div>
  );
}
