import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import {
  useGcAvatars,
  useMediaStats,
  useReconcileMedia,
  useTriggerMediaGc,
} from '@/hooks/use-media'
import { useIsSuperAdmin } from '@/hooks/use-me'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { TableBodyState } from '@/components/common/table-state'
import { formatApiError } from '@/lib/format-error'

type GcAction = 'gc' | 'reconcile' | 'avatars'

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function MetricTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  )
}

/** Media storage overview + GC triggers. Stats are open to all roles; the GC actions are super-admin
 *  only (the backend endpoints are SUPER_ADMIN-gated) and each runs behind a confirm dialog. */
export function MediaPage() {
  const { t } = useTranslation()
  const { data, isLoading, error } = useMediaStats()
  const isSuper = useIsSuperAdmin()
  const gc = useTriggerMediaGc()
  const reconcile = useReconcileMedia()
  const avatars = useGcAvatars()
  const [pending, setPending] = useState<GcAction | null>(null)

  const busy = gc.isPending || reconcile.isPending || avatars.isPending

  const run = async (a: GcAction) => {
    try {
      if (a === 'gc') {
        const r = await gc.mutateAsync()
        toast.success(t('media.gcDone', { rows: r.reapedRows, files: r.reapedFiles }))
      } else if (a === 'reconcile') {
        const r = await reconcile.mutateAsync()
        toast.success(t('media.reconcileDone', { files: r.reapedFiles }))
      } else {
        const r = await avatars.mutateAsync()
        toast.success(t('media.avatarsDone', { files: r.sweptFiles }))
      }
    } catch (e) {
      toast.error(formatApiError(e))
    }
    setPending(null)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('media.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('media.desc')}</p>
        </div>
        {isSuper ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setPending('gc')}>
              {t('media.gc')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPending('avatars')}>
              {t('media.gcAvatars')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={() => setPending('reconcile')}
            >
              {t('media.reconcile')}
            </Button>
          </div>
        ) : null}
      </div>

      {isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {t('common.loadFailed', { message: formatApiError(error) })}
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricTile
              label={t('media.tileDbBytes')}
              value={formatBytes(Number(data.db.bytes))}
            />
            <MetricTile label={t('media.tileAssets')} value={String(data.db.assetCount)} />
            <MetricTile
              label={t('media.tileReclaimable')}
              value={String(data.db.reclaimable)}
              sub={t('media.reclaimableHint')}
            />
            <MetricTile
              label={t('media.tileOnDisk')}
              value={formatBytes(Number(data.onDisk.bytes))}
              sub={t('media.onDiskFiles', { files: data.onDisk.files })}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t('media.byExt')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('media.col.ext')}</TableHead>
                    <TableHead className="w-24">{t('media.col.files')}</TableHead>
                    <TableHead className="w-32">{t('media.col.bytes')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableBodyState
                    loading={false}
                    error={null}
                    empty={data.onDisk.byExt.length === 0}
                    colSpan={3}
                    emptyMessage={t('media.emptyExt')}
                  >
                    {data.onDisk.byExt.map((b) => (
                      <TableRow key={b.ext}>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-xs">
                            {b.ext}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">{b.files}</TableCell>
                        <TableCell className="tabular-nums">
                          {formatBytes(Number(b.bytes))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBodyState>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      ) : null}

      <Dialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        {pending ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(`media.confirmTitle.${pending}`)}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{t(`media.confirmBody.${pending}`)}</p>
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setPending(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant={pending === 'reconcile' ? 'destructive' : 'default'}
                disabled={busy}
                onClick={() => run(pending)}
              >
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                {t(`media.confirmAction.${pending}`)}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  )
}
