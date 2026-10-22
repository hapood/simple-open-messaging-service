import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Timestamp } from '@/components/common/timestamp'
import { useUserSessions } from '@/hooks/use-user-mutations'
import { useRevokeSession } from '@/hooks/use-sessions'
import { useIsAdminPlus } from '@/hooks/use-me'
import { formatApiError } from '@/lib/format-error'
import type { User } from '@/types/api'

export function SessionsDialog({
  user,
  onClose,
}: {
  user: User | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { data, isLoading, error } = useUserSessions(user?.id ?? null)
  const revoke = useRevokeSession()
  const isAdminPlus = useIsAdminPlus()
  const [confirmingId, setConfirmingId] = useState<number | null>(null)
  const appCount = data?.filter((s) => s.client === 'app').length ?? 0
  const open = user !== null

  const onRevoke = async (id: number) => {
    try {
      await revoke.mutateAsync(id)
      toast.success(t('userSessions.revoked'))
      setConfirmingId(null)
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('userSessions.title', { name: user?.account ?? '' })}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {t('userSessions.appCount', { count: appCount })}
          </p>
          {isAdminPlus && (
            <p className="text-xs text-muted-foreground">
              {t('userSessions.canRevokeHint')}
            </p>
          )}
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('userSessions.col.device')}</TableHead>
                <TableHead>{t('userSessions.col.client')}</TableHead>
                <TableHead>{t('userSessions.col.ua')}</TableHead>
                <TableHead>{t('userSessions.col.ip')}</TableHead>
                <TableHead>{t('userSessions.col.lastIp')}</TableHead>
                <TableHead>{t('userSessions.col.created')}</TableHead>
                <TableHead>{t('userSessions.col.lastActive')}</TableHead>
                <TableHead>{t('userSessions.col.expires')}</TableHead>
                {isAdminPlus && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={isAdminPlus ? 9 : 8}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ) : error ? (
                <TableRow>
                  <TableCell colSpan={isAdminPlus ? 9 : 8} className="text-destructive">
                    {t('userSessions.loadFailed')}
                  </TableCell>
                </TableRow>
              ) : !data || data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isAdminPlus ? 9 : 8} className="py-6 text-center text-muted-foreground">
                    {t('userSessions.empty')}
                  </TableCell>
                </TableRow>
              ) : (
                data.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <Badge variant="outline">{s.device ?? '—'}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="secondary">
                          {t(`common.client.${s.client}`, { defaultValue: s.client })}
                        </Badge>
                        {s.trusted && <Badge variant="default">{t('common.trusted')}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell
                      className="max-w-[280px] truncate text-xs text-muted-foreground"
                      title={s.userAgent ?? ''}
                    >
                      {s.userAgent ?? '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.ip ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{s.lastSeenIp ?? '—'}</TableCell>
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
                              {t('userSessions.confirmRevoke')}
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive"
                            onClick={() => setConfirmingId(s.id)}
                          >
                            {t('userSessions.revoke')}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  )
}
