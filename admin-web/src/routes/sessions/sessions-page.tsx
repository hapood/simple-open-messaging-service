import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { useAllSessions, usePurgeSessions } from '@/hooks/use-sessions'
import { formatApiError } from '@/lib/format-error'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
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
import { Timestamp } from '@/components/common/timestamp'

const PAGE_SIZE = 50

export function SessionsPage() {
  const { t } = useTranslation()
  const [ipSearch, setIpSearch] = useState('')
  const [page, setPage] = useState(0)
  const [purgeOpen, setPurgeOpen] = useState(false)
  const { data, isLoading, error } = useAllSessions({
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE,
    ip: ipSearch || undefined,
  })
  const purge = usePurgeSessions()

  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

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
              value={ipSearch}
              onChange={(e) => {
                setIpSearch(e.target.value)
                setPage(0)
              }}
              className="pl-8"
            />
          </div>
          <Button variant="destructive" onClick={() => setPurgeOpen(true)} disabled={total === 0}>
            {t('sessions.purge')}
          </Button>
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
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : error ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-destructive">
                  {t('common.loadFailed', { message: formatApiError(error) })}
                </TableCell>
              </TableRow>
            ) : data?.list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  {t('sessions.empty')}
                </TableCell>
              </TableRow>
            ) : (
              data?.list.map((s) => (
                <TableRow key={s.jti}>
                  <TableCell className="font-medium">
                    {s.user?.uniqName ?? '#' + s.userId}
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
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          {t('common.previous')}
        </Button>
        <span>{t('common.page', { page: page + 1, pages: pageCount })}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={page + 1 >= pageCount}
          onClick={() => setPage((p) => p + 1)}
        >
          {t('common.next')}
        </Button>
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
