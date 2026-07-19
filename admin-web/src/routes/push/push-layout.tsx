import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { RouteTabs } from '@/components/common/route-tabs'

/** Push hub shell: route-driven tabs (Devices | Transport config). Devices is the registered-token
 *  list + test push; Transport config holds the VAPID keypair, FCM status, and the VAPID health
 *  check (the push-credential cards that previously lived under Settings). */
export function PushLayout() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('push.title')}</h1>
      <RouteTabs
        tabs={[
          { to: '/push', label: t('push.tabs.devices') },
          { to: '/push/config', label: t('push.tabs.config') },
        ]}
      />
      <Outlet />
    </div>
  )
}
