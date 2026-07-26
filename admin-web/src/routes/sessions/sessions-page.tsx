import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { useAllSessions, usePurgeSessions, useRevokeSession } from '@/hooks/use-sessions'
import { useListParams } from '@/hooks/use-list-params'
import { useIsSuperAdmin, useIsAdminPlus } from '@/hooks/use-me'
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
  const [confirmingId, setConfirmingId] = useState<number | null>(null)
  const { searchInput, setSearchInput, search, page, setPage, skip, take } = useListParams({
    pageSize: PAGE_SIZE,
  })
  const { data, isLoading, error } = useAllSessions({
    skip,
    take,
    ip: search || undefined,
  })
  const purge = usePurgeSessions()
  const revoke = useRevokeSession()
  const isAdminPlus = useIsAdminPlus()

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

  const onRevoke = async (id: number) => {
    try {
      await revoke.mutateAsync(id)
      toast.success(t('sessions.revoked'))
      setConfirmingId(null)
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">{t('sessions.desc', { count: total })}</p>
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
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('sessions.col.user')}</TableHead>
              <TableHead>{t('sessions.col.client')}</TableHead>
              <TableHead>{t('sessions.col.device')}</TableHead>
              <TableHead>{t('sessions.col.ua')}</TableHead>
              <TableHead>{t('sessions.col.ip')}</TableHead>
              <TableHead>{t('sessions.col.created')}</TableHead>
              <TableHead>{t('sessions.col.lastActive')}</TableHead>
              <TableHead>{t('sessions.col.expires')}</TableHead>
              {isAdminPlus && <TableHead className="w-20" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={isAdminPlus ? 9 : 8}
              emptyMessage={t('sessions.empty')}
            >
              {data?.list.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    {s.user?.account ?? '#' + s.userId}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant="secondary">
                        {t(`common.client.${s.client}`, { defaultValue: s.client })}
                      </Badge>
                      {s.trusted && <Badge variant="default">{t('common.trusted')}</Badge>}
                    </div>
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
                  {/* IP shown is the most recent (lastSeenIp); hover reveals the sign-in ip. */}
                  <TableCell className="font-mono text-xs" title={s.ip ?? ''}>
                    {s.lastSeenIp ?? s.ip ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Timestamp value={s.createdAt} />
                  </TableCell>
                  <TableCell>
                    <Timestamp value={s.lastSeenAt} />
                  </TableCell>
                  <TableCell>
                    {s.expiresAt ? (
                      <Timestamp value={s.expiresAt} />
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t('common.neverExpires')}
                      </span>
                    )}
                  </TableCell>
                  {isAdminPlus && (
                    <TableCell>
                      {confirmingId === s.id ? (
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setConfirmingId(null)}
                            disabled={revoke.isPending}
                          >
                            {t('common.cancel')}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => onRevoke(s.id)}
                            disabled={revoke.isPending}
                          >
                            {t('sessions.confirmRevoke')}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive"
                          onClick={() => setConfirmingId(s.id)}
                        >
                          {t('sessions.revoke')}
                        </Button>
                      )}
                    </TableCell>
                  )}
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
