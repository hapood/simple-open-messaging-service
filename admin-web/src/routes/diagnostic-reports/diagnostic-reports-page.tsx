import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  useDeleteDiagnosticReport,
  useDiagnosticReports,
} from '@/hooks/use-diagnostic-reports'
import {
  downloadDiagnosticReport,
  type DiagnosticReportListItem,
} from '@/api/diagnostic-reports'
import { useListParams } from '@/hooks/use-list-params'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Pagination } from '@/components/common/pagination'
import { TableBodyState } from '@/components/common/table-state'
import { Timestamp } from '@/components/common/timestamp'

const PAGE_SIZE = 50

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Read a string field off the client-supplied manifest (defensive — the manifest is best-effort). */
function manifestField(m: Record<string, unknown>, key: string): string {
  const v = m[key]
  return typeof v === 'string' && v.length > 0 ? v : '—'
}

/**
 * Admin diagnostic-reports viewer. Lists client-uploaded log bundles with the reporter's identity
 * (name + account), the platform + version snapshot from the manifest, bundle size, status, and time;
 * per-row Download (fetch the .tar.gz) and Delete (soft-delete + unlink, with a confirm dialog).
 * URL-synced (reporter search + page).
 */
export function DiagnosticReportsPage() {
  const { t } = useTranslation()
  const { searchInput, setSearchInput, search, page, setPage, skip, take } =
    useListParams({ pageSize: PAGE_SIZE })

  const { data, isLoading, error } = useDiagnosticReports({
    skip,
    take,
    search: search || undefined,
  })
  const delMut = useDeleteDiagnosticReport()
  const total = data?.total ?? 0
  const [downloadingId, setDownloadingId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DiagnosticReportListItem | null>(null)

  async function onDownload(item: DiagnosticReportListItem): Promise<void> {
    setDownloadingId(item.id)
    try {
      await downloadDiagnosticReport(item.id)
    } catch {
      toast.error(t('diagnosticReports.downloadFailed'))
    } finally {
      setDownloadingId(null)
    }
  }

  function onConfirmDelete(): void {
    if (!deleteTarget) return
    const id = deleteTarget.id
    delMut.mutate(id, {
      onSuccess: () => {
        toast.success(t('diagnosticReports.deleted'))
        setDeleteTarget(null)
      },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t('diagnosticReports.desc')}</p>

      <div className="flex items-center justify-end">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder={t('diagnosticReports.searchPlaceholder')}
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
              <TableHead>{t('diagnosticReports.col.reporter')}</TableHead>
              <TableHead className="w-28">{t('diagnosticReports.col.platform')}</TableHead>
              <TableHead>{t('diagnosticReports.col.versions')}</TableHead>
              <TableHead className="w-24">{t('diagnosticReports.col.size')}</TableHead>
              <TableHead className="w-24">{t('diagnosticReports.col.status')}</TableHead>
              <TableHead className="w-44">{t('diagnosticReports.col.at')}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={7}
              emptyMessage={t('diagnosticReports.empty')}
            >
              {data?.list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{r.reporter.name}</span>
                      <span className="text-xs text-muted-foreground">{r.reporter.account}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {manifestField(r.manifest, 'platform')}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    app {manifestField(r.manifest, 'app')} · shell{' '}
                    {manifestField(r.manifest, 'shell')} · srv {manifestField(r.manifest, 'server')}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{fmtBytes(r.bundleBytes)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Timestamp value={r.createdAt} />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={() => onDownload(r)}
                        disabled={downloadingId === r.id}
                        title={t('diagnosticReports.download')}
                      >
                        <Download className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={() => setDeleteTarget(r)}
                        title={t('diagnosticReports.delete')}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
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

      <Dialog open={deleteTarget !== null} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('diagnosticReports.deleteConfirm')}</DialogTitle>
            <DialogDescription>{t('diagnosticReports.deleteConfirmDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" disabled={delMut.isPending} onClick={onConfirmDelete}>
              {t('diagnosticReports.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
