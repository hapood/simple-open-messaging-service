import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useBreakers } from '@/hooks/use-quota'
import { ContinueQuotaDialog } from '@/components/admin/continue-quota-dialog'
import type { BreakerStatus } from '@/types/api'

/** Top-of-console banner shown while any quota circuit breaker is tripped. Lists the paused federation peers
 *  and local users; clicking one opens {@link ContinueQuotaDialog} to add today's additive quota. Polled by
 *  useBreakers. Renders nothing when all clear. */
export function BreakerBanner() {
  const { t } = useTranslation()
  const breakers = useBreakers()
  const [selected, setSelected] = useState<BreakerStatus | null>(null)

  const peers = breakers.data?.peers ?? []
  const users = breakers.data?.users ?? []
  if (peers.length === 0 && users.length === 0) return null

  return (
    <>
      <div
        role="alert"
        className="mb-4 flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm sm:flex-row sm:items-center sm:gap-3"
      >
        <div className="flex items-center gap-2 font-medium text-destructive">
          <TriangleAlert className="size-4 shrink-0" />
          {t('quota.breaker.bannerTitle')}
        </div>
        <div className="text-muted-foreground">
          {t('quota.breaker.bannerBody', { peers: peers.length, users: users.length })}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5 sm:ml-auto sm:mt-0">
          {peers.map((b) => (
            <BreakerChip key={`peer-${b.entity}`} label={`peer · ${b.entity}`} onClick={() => setSelected(b)} />
          ))}
          {users.map((b) => (
            <BreakerChip key={`user-${b.entity}`} label={`user · ${b.entity}`} onClick={() => setSelected(b)} />
          ))}
        </div>
      </div>
      {selected ? (
        <ContinueQuotaDialog breaker={selected} onClose={() => setSelected(null)} />
      ) : null}
    </>
  )
}

function BreakerChip({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-destructive/40 bg-background px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
    >
      {label} · {t('quota.breaker.review')}
    </button>
  )
}
