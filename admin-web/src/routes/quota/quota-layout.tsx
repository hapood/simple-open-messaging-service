import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RouteTabs } from '@/components/common/route-tabs';

export function QuotaLayout() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 text-sm leading-[20px]">
      <h1 className="text-2xl font-semibold leading-[32px]">
        {t('nav.quota')}
      </h1>
      <RouteTabs
        tabs={[
          { to: '/quota', label: t('quotaCenter.overview') },
          { to: '/quota/defaults', label: t('quotaCenter.defaults') },
        ]}
      />
      <Outlet />
    </div>
  );
}
