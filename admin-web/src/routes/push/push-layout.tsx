import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { RouteTabs } from '@/components/common/route-tabs'

/** Push hub shell: registered devices and tests, plus read-only push channel status. */
export function PushLayout() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">
        {t('push.title')}
      </h1>
      <RouteTabs
        tabs={[
          { to: '/push', label: t('push.tabs.devices') },
          { to: '/push/config', label: t('credentials.channels') },
        ]}
      />
      <Outlet />
    </div>
  )
}
