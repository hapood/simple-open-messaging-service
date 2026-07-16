import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
import { useRevokeLoginCode, useUserLoginCodes } from '@/hooks/use-user-mutations'
import type { LoginCodeView } from '@/types/api'

type CodeStatus = 'pending' | 'consumed' | 'expired' | 'revoked'

/** Derive the display status of a code: revoked wins, then consumed, then expired-by-clock, else pending. */
function codeStatus(c: LoginCodeView): CodeStatus {
  if (c.revokedAt) return 'revoked'
  if (c.consumedAt) return 'consumed'
  if (c.expiresAt <= Date.now()) return 'expired'
  return 'pending'
}

/** Login-code audit section for the user detail page. Lists every admin-issued one-time code with its
 *  status, issue/expire/consume times, the consuming IP/device, and the produced session id (the safe audit
 *  link — never the token). Unused codes can be revoked. The codeHash and token value are never present. */
export function LoginCodesSection({ userId }: { userId: number }) {
  const { t } = useTranslation()
  const { data, isLoading } = useUserLoginCodes(userId)
  const revoke = useRevokeLoginCode(userId)

  const onRevoke = async (id: number) => {
    try {
      await revoke.mutateAsync(id)
      toast.success(t('loginCodes.toast.revoked'))
    } catch {
      /* Global mutation onError already shows a toast. */
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('loginCodes.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-full" />
        ) : !data || data.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t('loginCodes.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">{t('loginCodes.col.status')}</TableHead>
                  <TableHead>{t('loginCodes.col.issuedAt')}</TableHead>
                  <TableHead>{t('loginCodes.col.expiresAt')}</TableHead>
                  <TableHead>{t('loginCodes.col.consumedAt')}</TableHead>
                  <TableHead>{t('loginCodes.col.consumedIp')}</TableHead>
                  <TableHead>{t('loginCodes.col.device')}</TableHead>
                  <TableHead className="w-24">{t('loginCodes.col.session')}</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((c) => {
                  const st = codeStatus(c)
                  return (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Badge variant={st === 'revoked' ? 'destructive' : 'secondary'}>
                          {t(`loginCodes.status.${st}`)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Timestamp value={c.issuedAt} />
                      </TableCell>
                      <TableCell>
                        <Timestamp value={c.expiresAt} />
                      </TableCell>
                      <TableCell>
                        {c.consumedAt ? <Timestamp value={c.consumedAt} /> : '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{c.consumedIp ?? '—'}</TableCell>
                      <TableCell
                        className="max-w-[200px] truncate text-xs text-muted-foreground"
                        title={c.consumedDevice ?? ''}
                      >
                        {c.consumedDevice ?? '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {c.producedSessionId ?? '—'}
                      </TableCell>
                      <TableCell>
                        {st === 'pending' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive"
                            disabled={revoke.isPending}
                            onClick={() => onRevoke(c.id)}
                          >
                            {t('loginCodes.revoke')}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
