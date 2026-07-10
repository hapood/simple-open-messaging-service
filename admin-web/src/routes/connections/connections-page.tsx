import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import { useConnections } from '@/hooks/use-connections'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TableBodyState } from '@/components/common/table-state'
import { Timestamp } from '@/components/common/timestamp'

/** Compact human-readable duration "1d 2h" / "5m 10s" / "12s" from milliseconds. */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export function ConnectionsPage() {
  const { t } = useTranslation()
  const { data, isLoading, error, dataUpdatedAt } = useConnections()
  const total = data?.total ?? 0
  const uniqueUsers = data?.uniqueUsers ?? 0
  const clients = data?.clients ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t('connections.title')}</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            LIVE
          </span>
        </div>
        {dataUpdatedAt ? (
          <span className="text-xs text-muted-foreground">
            {t('connections.updatedAt', { time: dayjs(dataUpdatedAt).format('HH:mm:ss') })}
          </span>
        ) : null}
      </div>

      <p className="text-sm text-muted-foreground">{t('connections.desc')}</p>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-2">
        <div className="rounded-md border p-4">
          <div className="text-sm text-muted-foreground">{t('connections.totalConn')}</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{total}</div>
        </div>
        <div className="rounded-md border p-4">
          <div className="text-sm text-muted-foreground">{t('connections.onlineUsers')}</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{uniqueUsers}</div>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('connections.col.user')}</TableHead>
              <TableHead className="w-32">{t('connections.col.count')}</TableHead>
              <TableHead className="w-48">{t('connections.col.since')}</TableHead>
              <TableHead className="w-32">{t('connections.col.duration')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={clients.length === 0}
              colSpan={4}
              skeletonRows={5}
              emptyMessage={t('connections.empty')}
            >
              {clients.map((c) => (
                <TableRow key={c.userId}>
                  <TableCell className="font-medium">
                    {c.account ?? '#' + c.userId}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="tabular-nums">
                      {c.connections}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Timestamp value={c.since} />
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {formatDuration(Date.now() - c.since)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBodyState>
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
