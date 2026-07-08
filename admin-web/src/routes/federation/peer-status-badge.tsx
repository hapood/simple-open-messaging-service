import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import type { FederationTrustLevel } from '@/types/api'

/** The trust-level badge, color-coded so the lifecycle state is scannable at a glance in the list +
 *  detail header. The variant set has no green/amber, so trusted/demoted/pending are className
 *  overrides on the outline variant; blocked reuses the destructive variant. */
const STYLE: Record<
  FederationTrustLevel,
  { variant?: 'destructive' | 'outline'; cls: string }
> = {
  trusted: { cls: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  demoted: { cls: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  pending: { cls: 'border-transparent bg-muted text-muted-foreground' },
  blocked: { variant: 'destructive', cls: '' },
}

export function PeerStatusBadge({ level }: { level: FederationTrustLevel }) {
  const { t } = useTranslation()
  const s = STYLE[level] ?? STYLE.pending
  return (
    <Badge variant={s.variant ?? 'outline'} className={s.cls}>
      {t(`federation.status.${level}`)}
    </Badge>
  )
}
