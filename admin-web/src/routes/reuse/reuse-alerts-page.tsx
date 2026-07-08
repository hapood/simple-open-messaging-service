import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useReuseAlerts } from '@/hooks/use-reuse-alerts'
import { formatApiError } from '@/lib/format-error'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-destructive">
                  {t('common.loadFailed', { message: formatApiError(error) })}
                </TableCell>
              </TableRow>
            ) : !data || data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  {t('reuse.empty')}
                </TableCell>
              </TableRow>
            ) : (
              data.map((r) => (
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
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
