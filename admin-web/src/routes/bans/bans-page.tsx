import { useTranslation } from 'react-i18next'
import { ShieldOff } from 'lucide-react'
import { useBans, useUnban } from '@/hooks/use-bans'
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
import { TableBodyState } from '@/components/common/table-state'
import { Timestamp } from '@/components/common/timestamp'
import type { Ban } from '@/types/api'

export function BansPage() {
  const { t } = useTranslation()
  const { data, isLoading, error } = useBans()
  const unban = useUnban()

  // Dimension value → human label. Keys mirror the API `type` union so Record<Ban['type'],…> enforces all
  // cases at compile time (a new dimension can't land silently unlabeled). user/otp both unban as an account
  // (an account unban clears every account-keyed dimension — password + OTP — server-side).
  const typeLabel: Record<Ban['type'], string> = {
    ip: t('bans.type.ip'),
    user: t('bans.type.user'),
    otp: t('bans.type.otp'),
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('bans.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('bans.desc')}</p>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">{t('bans.col.type')}</TableHead>
              <TableHead>{t('bans.col.value')}</TableHead>
              <TableHead>{t('bans.col.until')}</TableHead>
              <TableHead className="w-24">{t('bans.col.remaining')}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={!data || data.length === 0}
              colSpan={5}
              skeletonRows={6}
              emptyMessage={
                <div>
                  <ShieldOff className="mx-auto mb-2 size-5 opacity-40" />
                  {t('bans.empty')}
                </div>
              }
            >
              {data?.map((b) => (
                <TableRow key={b.key}>
                  <TableCell>
                    <Badge variant={b.type === 'ip' ? 'default' : 'secondary'}>
                      {typeLabel[b.type]}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{b.value}</TableCell>
                  <TableCell>
                    <Timestamp value={b.until} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {Math.ceil(b.remainingMs / 1000)}s
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={unban.isPending}
                      onClick={() =>
                        unban.mutate(b.type === 'ip' ? { ip: b.value } : { account: b.value })
                      }
                    >
                      {t('bans.unban')}
                    </Button>
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
