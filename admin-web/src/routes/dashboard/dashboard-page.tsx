import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle } from 'lucide-react'
import { useDashboard } from '@/hooks/use-dashboard'
import type { DashboardFederation } from '@/types/api'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Timestamp } from '@/components/common/timestamp'
import { formatApiError } from '@/lib/format-error'

/** Compact human byte size: "1.2 GB" / "512 MB" / "0 B". */
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function MetricTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-md border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  )
}

const FED_ROWS: { key: keyof DashboardFederation; tone: string }[] = [
  { key: 'trusted', tone: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'demoted', tone: 'text-amber-600 dark:text-amber-400' },
  { key: 'pending', tone: 'text-muted-foreground' },
  { key: 'blocked', tone: 'text-destructive' },
]

/** Landing overview. Tiles + federation breakdown + the last admin actions (sourced from
 *  AdminActionLog, written by the Phase 1 audit interceptor). Polled every 15s by useDashboard. */
export function DashboardPage() {
  const { t } = useTranslation()
  const { data, isLoading, error } = useDashboard()
  const loading = isLoading && !data

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
        <span className="text-xs text-muted-foreground">{t('dashboard.autoRefresh')}</span>
      </div>
      <p className="text-sm text-muted-foreground">{t('dashboard.desc')}</p>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {t('common.loadFailed', { message: formatApiError(error) })}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricTile
          label={t('dashboard.tile.onlineNow')}
          value={loading ? <Skeleton className="h-8 w-16" /> : data!.online.uniqueUsers}
        />
        <MetricTile
          label={t('dashboard.tile.onlineConnections')}
          value={loading ? <Skeleton className="h-8 w-16" /> : data!.online.totalConnections}
        />
        <MetricTile
          label={t('dashboard.tile.activeSessions')}
          value={loading ? <Skeleton className="h-8 w-16" /> : data!.activeSessions}
        />
        <MetricTile
          label={t('dashboard.tile.storageUsage')}
          value={loading ? <Skeleton className="h-8 w-20" /> : formatBytes(Number(data!.media.bytes))}
          sub={
            loading
              ? undefined
              : t('dashboard.mediaSub', {
                  assets: data!.media.assetCount,
                  reclaimable: data!.media.reclaimable,
                })
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.tile.federationHealth')}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            {FED_ROWS.map((r) => (
              <div key={r.key} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-sm text-muted-foreground">{t(`federation.status.${r.key}`)}</span>
                <span className={`text-lg font-semibold tabular-nums ${r.tone}`}>
                  {loading ? '—' : data!.federation[r.key]}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.tile.recentActions')}</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : data!.recentActions.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('dashboard.noRecentActions')}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {data!.recentActions.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                  >
                    {a.success ? (
                      <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                    ) : (
                      <span title={a.errorMessage ?? undefined}>
                        <XCircle className="size-4 shrink-0 text-destructive" />
                      </span>
                    )}
                    <span className="font-mono text-xs">{a.action}</span>
                    {a.targetId ? (
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {a.targetId}
                      </span>
                    ) : null}
                    <Badge variant="outline" className="ml-auto shrink-0 text-[10px]">
                      {a.adminRole}
                    </Badge>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <Timestamp value={a.at} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
