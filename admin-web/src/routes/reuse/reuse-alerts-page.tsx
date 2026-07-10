import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useReuseAlerts } from '@/hooks/use-reuse-alerts'
import { Button } from '@/components/ui/button'
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

const SIZES = [50, 100, 200]

export function ReuseAlertsPage() {
  const { t } = useTranslation()
  const [take, setTake] = useState(50)
  const { data, isLoading, error } = useReuseAlerts(take)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('reuse.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('reuse.desc')}</p>
        </div>
        <div className="flex items-center gap-1">
          {SIZES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={take === s ? 'default' : 'outline'}
              onClick={() => setTake(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('reuse.col.userId')}</TableHead>
              <TableHead>{t('reuse.col.familyId')}</TableHead>
              <TableHead>{t('reuse.col.jti')}</TableHead>
              <TableHead>{t('reuse.col.ip')}</TableHead>
              <TableHead>{t('reuse.col.ua')}</TableHead>
              <TableHead>{t('reuse.col.revokedAt')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={!data || data.length === 0}
              colSpan={6}
              skeletonRows={6}
              emptyMessage={t('reuse.empty')}
            >
              {data?.map((r) => (
                <TableRow key={r.jti}>
                  <TableCell className="font-mono text-xs">{r.userId}</TableCell>
                  <TableCell
                    className="max-w-[160px] truncate font-mono text-xs"
                    title={r.familyId}
                  >
                    {r.familyId}
                  </TableCell>
                  <TableCell className="max-w-[160px] truncate font-mono text-xs" title={r.jti}>
                    {r.jti}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.ip ?? '—'}</TableCell>
                  <TableCell
                    className="max-w-[220px] truncate text-xs text-muted-foreground"
                    title={r.userAgent ?? ''}
                  >
                    {r.userAgent ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Timestamp value={r.revokedAt} />
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
