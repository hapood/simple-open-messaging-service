import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { RouteTabs } from '@/components/common/route-tabs'

/** Federation hub shell: route-driven tabs (Peers | Self-check). The peer list is the index route;
 *  the S2S handshake self-check is /federation/self-check. Peer detail (/federation/:domain) is a
 *  full-page sibling route, not rendered through this shell. */
export function FederationLayout() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('federation.title')}</h1>
      <RouteTabs
        tabs={[
          { to: '/federation', label: t('federation.tabs.peers') },
          { to: '/federation/self-check', label: t('federation.tabs.selfCheck') },
        ]}
      />
      <Outlet />
    </div>
  )
}
