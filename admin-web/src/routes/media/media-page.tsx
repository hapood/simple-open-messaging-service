import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  useAbortResumableUpload,
  useCleanFederationDownload,
  useFederationDownloads,
  useMediaStats,
  useResumableUploads,
  useRetryFederationDownload,
} from '@/hooks/use-media';
import { useIsSuperAdmin } from '@/hooks/use-me';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TableBodyState } from '@/components/common/table-state';
import { formatApiError } from '@/lib/format-error';

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function MetricTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {sub ? (
        <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  );
}

/** Read-only CAS totals plus explicit inbound-download and client-upload operations. */
export function MediaPage() {
  const { t } = useTranslation();
  const isSuper = useIsSuperAdmin();
  const stats = useMediaStats();
  const downloads = useFederationDownloads(isSuper);
  const retryDownload = useRetryFederationDownload();
  const cleanDownload = useCleanFederationDownload();
  const uploads = useResumableUploads(isSuper);
  const abortUpload = useAbortResumableUpload();

  const refreshTransfers = () =>
    void Promise.all([downloads.refetch(), uploads.refetch()]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('media.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('media.desc')}
          </p>
        </div>
        {isSuper ? (
          <Button
            variant="outline"
            size="sm"
            disabled={downloads.isFetching || uploads.isFetching}
            onClick={refreshTransfers}
          >
            {(downloads.isFetching || uploads.isFetching) && (
              <Loader2 className="mr-2 size-4 animate-spin" />
            )}
            {t('media.refresh')}
          </Button>
        ) : null}
      </div>

      {stats.isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : stats.error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {t('common.loadFailed', { message: formatApiError(stats.error) })}
        </div>
      ) : stats.data ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <MetricTile
            label={t('media.tileDbBytes')}
            value={formatBytes(Number(stats.data.db.bytes))}
          />
          <MetricTile
            label={t('media.tileAssets')}
            value={String(stats.data.db.assetCount)}
            sub={t('media.assetStatusHint', {
              live: stats.data.db.live,
              deleted: stats.data.db.deleted,
            })}
          />
          <MetricTile
            label={t('media.tileOnDisk')}
            value={formatBytes(Number(stats.data.onDisk.bytes))}
          />
          <MetricTile
            label={t('media.tileFiles')}
            value={String(stats.data.onDisk.files)}
          />
        </div>
      ) : null}

      {isSuper ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('media.downloadsTitle')}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t('media.downloadsDesc')}
            </p>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('media.downloadSource')}</TableHead>
                  <TableHead>{t('media.downloadMessage')}</TableHead>
                  <TableHead>{t('media.downloadProgress')}</TableHead>
                  <TableHead>{t('media.downloadUpdated')}</TableHead>
                  <TableHead className="w-44" />
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableBodyState
                  loading={downloads.isLoading}
                  error={downloads.error}
                  empty={!downloads.data?.batches.length}
                  colSpan={5}
                  emptyMessage={t('media.downloadsEmpty')}
                >
                  {downloads.data?.batches.map((batch) => {
                    const total = batch.files.reduce(
                      (sum, file) => sum + Number(file.bytesTotal),
                      0,
                    );
                    const received = batch.files.reduce(
                      (sum, file) => sum + Number(file.bytesReceived),
                      0,
                    );
                    const failed = batch.anyFailed || batch.status === 'failed';
                    const terminal = failed || batch.status === 'ready';
                    return (
                      <TableRow key={batch.batchId}>
                        <TableCell>
                          <div className="font-medium">
                            {batch.originDomain ?? batch.creator.domain}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {batch.creator.account}@{batch.creator.domain}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-xs">
                            thread #{batch.threadId} · seq {batch.messageSeq}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {batch.contentType} · originSeq{' '}
                            {batch.originSeq ?? '—'}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Badge variant={failed ? 'destructive' : 'outline'}>
                              {batch.status}
                            </Badge>
                            <span>
                              {batch.files.length}/{batch.fileCnt}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {formatBytes(received)} / {formatBytes(total)}
                            {batch.failReason ? ` · ${batch.failReason}` : ''}
                          </div>
                        </TableCell>
                        <TableCell>
                          {new Date(batch.updatedAt).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!failed || retryDownload.isPending}
                              onClick={async () => {
                                try {
                                  await retryDownload.mutateAsync(
                                    batch.batchId,
                                  );
                                  toast.success(t('media.downloadRetried'));
                                } catch (error) {
                                  toast.error(formatApiError(error));
                                }
                              }}
                            >
                              {t('media.downloadRetry')}
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={!terminal || cleanDownload.isPending}
                              onClick={async () => {
                                if (
                                  !window.confirm(
                                    t('media.downloadCleanConfirm'),
                                  )
                                )
                                  return;
                                try {
                                  await cleanDownload.mutateAsync(
                                    batch.batchId,
                                  );
                                  toast.success(t('media.downloadCleaned'));
                                } catch (error) {
                                  toast.error(formatApiError(error));
                                }
                              }}
                            >
                              {t('media.downloadClean')}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBodyState>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {isSuper ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('media.uploadsTitle')}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t('media.uploadsDesc')}
            </p>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('media.uploadFile')}</TableHead>
                  <TableHead>{t('media.uploadOwner')}</TableHead>
                  <TableHead>{t('media.uploadProgress')}</TableHead>
                  <TableHead>{t('media.uploadUpdated')}</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableBodyState
                  loading={uploads.isLoading}
                  error={uploads.error}
                  empty={!uploads.data?.length}
                  colSpan={5}
                  emptyMessage={t('media.uploadsEmpty')}
                >
                  {uploads.data?.map((upload) => {
                    const percent = upload.totalBytes
                      ? Math.min(
                          100,
                          Math.floor((upload.offset / upload.totalBytes) * 100),
                        )
                      : 0;
                    return (
                      <TableRow key={upload.uploadId}>
                        <TableCell>
                          <div className="max-w-72 truncate font-medium">
                            {upload.originalName}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {upload.contentType} · {upload.mimeType}
                          </div>
                        </TableCell>
                        <TableCell>#{upload.creatorId}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{upload.status}</Badge>
                            <span>{percent}%</span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {formatBytes(upload.offset)} /{' '}
                            {formatBytes(upload.totalBytes)}
                          </div>
                        </TableCell>
                        <TableCell>
                          {new Date(upload.updatedAt).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={abortUpload.isPending}
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  t('media.uploadAbortConfirm', {
                                    name: upload.originalName,
                                  }),
                                )
                              )
                                return;
                              try {
                                await abortUpload.mutateAsync(upload.uploadId);
                                toast.success(t('media.uploadAborted'));
                              } catch (error) {
                                toast.error(formatApiError(error));
                              }
                            }}
                          >
                            {t('media.uploadAbort')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBodyState>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
