import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { useAdminSessions, useRevokeAdminSession } from '@/hooks/use-admin-sessions'
import { useListParams } from '@/hooks/use-list-params'
import { formatApiError } from '@/lib/format-error'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

export function AdminSessionsPage() {
  const { t } = useTranslation()
  const { searchInput, setSearchInput, search, page, setPage, skip, take } = useListParams({
    pageSize: PAGE_SIZE,
  })
  const { data, isLoading, error } = useAdminSessions({
    skip,
    take,
    ip: search || undefined,
  })
  const revoke = useRevokeAdminSession()

  const total = data?.total ?? 0

  const onRevoke = async (jti: string) => {
    try {
      await revoke.mutateAsync(jti)
      toast.success(t('adminSessions.revoked'))
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="max-w-xl text-sm text-muted-foreground">
          {t('adminSessions.desc', { count: total })}
        </p>
        <div className="relative w-60">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder={t('adminSessions.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('adminSessions.col.admin')}</TableHead>
              <TableHead>{t('adminSessions.col.ua')}</TableHead>
              <TableHead>{t('adminSessions.col.ip')}</TableHead>
              <TableHead>{t('adminSessions.col.created')}</TableHead>
              <TableHead>{t('adminSessions.col.expires')}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={6}
              skeletonRows={6}
              emptyMessage={t('adminSessions.empty')}
            >
              {data?.list.map((s) => (
                <TableRow key={s.jti}>
                  <TableCell className="font-medium">
                    <Badge variant="outline">{s.admin?.account ?? '#' + s.adminId}</Badge>
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
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive"
                      disabled={revoke.isPending}
                      onClick={() => onRevoke(s.jti)}
                    >
                      {t('adminSessions.revoke')}
                    </Button>
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
    </div>
  )
}
