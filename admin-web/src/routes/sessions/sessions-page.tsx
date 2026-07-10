import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { useAllSessions, usePurgeSessions } from '@/hooks/use-sessions'
import { useListParams } from '@/hooks/use-list-params'
import { useIsSuperAdmin } from '@/hooks/use-me'
import { formatApiError } from '@/lib/format-error'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Timestamp } from '@/components/common/timestamp'

const PAGE_SIZE = 50

export function SessionsPage() {
  const { t } = useTranslation()
  const isSuper = useIsSuperAdmin()
  const [purgeOpen, setPurgeOpen] = useState(false)
  const { searchInput, setSearchInput, search, page, setPage, skip, take } = useListParams({
    pageSize: PAGE_SIZE,
  })
  const { data, isLoading, error } = useAllSessions({
    skip,
    take,
    ip: search || undefined,
  })
  const purge = usePurgeSessions()

  const total = data?.total ?? 0

  const onPurge = async () => {
    try {
      const r = await purge.mutateAsync()
      toast.success(t('sessions.purged', { count: r.purgedUsers }))
      setPurgeOpen(false)
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t('sessions.title')}</h1>
        <div className="flex items-center gap-2">
          <div className="relative w-60">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder={t('sessions.searchPlaceholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-8"
            />
          </div>
          {isSuper ? (
            <Button variant="destructive" onClick={() => setPurgeOpen(true)} disabled={total === 0}>
              {t('sessions.purge')}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{t('sessions.desc', { count: total })}</p>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('sessions.col.user')}</TableHead>
              <TableHead>{t('sessions.col.device')}</TableHead>
              <TableHead>{t('sessions.col.ua')}</TableHead>
              <TableHead>{t('sessions.col.ip')}</TableHead>
              <TableHead>{t('sessions.col.created')}</TableHead>
              <TableHead>{t('sessions.col.expires')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={6}
              emptyMessage={t('sessions.empty')}
            >
              {data?.list.map((s) => (
                <TableRow key={s.jti}>
                  <TableCell className="font-medium">
                    {s.user?.account ?? '#' + s.userId}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{s.device ?? '—'}</Badge>
                  </TableCell>
                  <TableCell
                    className="max-w-[280px] truncate text-xs text-muted-foreground"
                    title={s.userAgent ?? ''}
                  >
                    {s.userAgent ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{s.ip ?? '—'}</TableCell>
                  <TableCell>
                    <Timestamp value={s.createdAt} />
                  </TableCell>
                  <TableCell>
                    <Timestamp value={s.expiresAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBodyState>
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end text-sm text-muted-foreground">
        <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </div>

      <Dialog open={purgeOpen} onOpenChange={setPurgeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('sessions.purgeTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('sessions.purgeBody', { count: total })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPurgeOpen(false)} disabled={purge.isPending}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={onPurge} disabled={purge.isPending}>
              {t('sessions.purgeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
