import { useMemo } from 'react'
import dayjs from 'dayjs'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { listHistory, type LogHistoryQuery } from '@/api/logs'
import { useListParams } from '@/hooks/use-list-params'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Pagination } from '@/components/common/pagination'
import { TableBodyState } from '@/components/common/table-state'
import { LEVEL_TEXT } from './log-line'

const PAGE_SIZE = 50

/** History search tab: queries rotated log files (newest-first) by level / substring, offset-paginated.
 *  The scan is bounded server-side; `truncated` is surfaced when the cap was hit. */
export function HistoryPanel() {
  const { t } = useTranslation()
  const { searchInput, setSearchInput, search, page, setPage, filter, setFilter, skip, take } =
    useListParams({ pageSize: PAGE_SIZE, filterParam: 'level' })
  const level = filter || undefined

  const params: LogHistoryQuery = useMemo(
    () => ({ skip, take, level, search: search.trim() || undefined }),
    [skip, take, level, search],
  )

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['admin', 'logs', 'history', params],
    queryFn: () => listHistory(params),
    placeholderData: (prev) => prev,
  })

  const list = data?.list ?? []
  const total = data?.total ?? 0

  const levelOptions = useMemo(
    () => [
      { value: 'all', label: t('logs.allLevels') },
      { value: 'debug', label: 'DEBUG' },
      { value: 'info', label: 'INFO' },
      { value: 'warn', label: 'WARN' },
      { value: 'error', label: 'ERROR' },
    ],
    [t],
  )
  const items = useMemo(
    () => Object.fromEntries(levelOptions.map((o) => [o.value, o.label])),
    [levelOptions],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={level ?? 'all'}
          onValueChange={(v) => setFilter(v === 'all' || v == null ? '' : String(v))}
          items={items}
        >
          <SelectTrigger size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {levelOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder={t('logs.searchPlaceholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-8 w-64"
        />
        {data?.truncated ? (
          <Badge variant="outline" className="text-amber-600 dark:text-amber-400">
            {t('logs.truncated')}
          </Badge>
        ) : null}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-36">{t('logs.col.time')}</TableHead>
              <TableHead className="w-20">{t('logs.col.level')}</TableHead>
              <TableHead className="w-44">{t('logs.col.context')}</TableHead>
              <TableHead>{t('logs.col.message')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={list.length === 0}
              colSpan={4}
              emptyMessage={t('logs.emptyHistory')}
            >
              {list.map((rec, i) => {
                const lvl = (rec.level || 'info').toLowerCase()
                return (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                      {dayjs(rec.time).format('MM-DD HH:mm:ss.SSS')}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'font-mono text-xs font-semibold uppercase',
                        LEVEL_TEXT[lvl] ?? LEVEL_TEXT.info,
                      )}
                    >
                      {lvl}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {rec.context ?? '—'}
                    </TableCell>
                    <TableCell className="break-all font-mono text-xs">{rec.msg}</TableCell>
                  </TableRow>
                )
              })}
            </TableBodyState>
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {isFetching ? t('common.loading') : t('logs.totalMatches', { count: total })}
        </span>
        <Pagination
          page={page}
          total={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          disabled={isFetching}
        />
      </div>
    </div>
  )
}
