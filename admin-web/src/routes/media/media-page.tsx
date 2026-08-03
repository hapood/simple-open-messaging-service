import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  useGcAvatars,
  useGcForwardBundles,
  useInspectForwardBundles,
  usePendingAssets,
  useForceTerminatePending,
  useMediaStats,
  useReconcileMedia,
  useTriggerMediaGc,
  useCancelMediaTask,
  useCurrentMediaTask,
  useMediaTaskProgress,
  useResumableUploads,
  useAbortResumableUpload,
} from '@/hooks/use-media';
import { useIsSuperAdmin } from '@/hooks/use-me';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { useLogStream } from '@/hooks/use-log-stream';
import { LogLine } from '@/routes/logs/log-line';

type GcAction = 'gc' | 'reconcile' | 'avatars' | 'forwardBundles';

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
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

/** Media storage overview + GC triggers. Stats are open to all roles; the GC actions are super-admin
 *  only (the backend endpoints are SUPER_ADMIN-gated) and each runs behind a confirm dialog. */
export function MediaPage() {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch: refetchStats } = useMediaStats();
  const isSuper = useIsSuperAdmin();
  const gc = useTriggerMediaGc();
  const reconcile = useReconcileMedia();
  const avatars = useGcAvatars();
  const inspectBundles = useInspectForwardBundles();
  const bundleGc = useGcForwardBundles();
  const pendingAssets = usePendingAssets(isSuper);
  const terminatePending = useForceTerminatePending();
  const resumableUploads = useResumableUploads(isSuper);
  const abortUpload = useAbortResumableUpload();
  const cancelTask = useCancelMediaTask();
  const currentTask = useCurrentMediaTask(isSuper);
  const [pending, setPending] = useState<GcAction | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const reportedTask = useRef<string | null>(null);
  const taskLogPanel = useRef<HTMLDivElement | null>(null);
  const { task, connected } = useMediaTaskProgress(taskId);
  const taskLogs = useLogStream('info', {
    scope: taskId ? 'media-gc' : undefined,
    taskId: taskId ?? undefined,
    enabled: taskId !== null,
  });

  useEffect(() => {
    if (
      !taskId &&
      currentTask.data &&
      ['running', 'cancelling'].includes(currentTask.data.status)
    ) {
      setTaskId(currentTask.data.id);
    }
  }, [currentTask.data, taskId]);

  useEffect(() => {
    if (!task || !['completed', 'cancelled', 'failed'].includes(task.status))
      return;
    if (reportedTask.current === `${task.id}:${task.status}`) return;
    reportedTask.current = `${task.id}:${task.status}`;
    void refetchStats();
    void pendingAssets.refetch();
    if (task.status === 'completed') toast.success(t('media.taskCompleted'));
    else if (task.status === 'cancelled') toast.info(t('media.taskCancelled'));
    else toast.error(task.error ?? t('media.taskFailed'));
  }, [task, pendingAssets.refetch, refetchStats, t]);

  useEffect(() => {
    const panel = taskLogPanel.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [taskLogs.lines.length]);

  const busy =
    gc.isPending ||
    reconcile.isPending ||
    avatars.isPending ||
    inspectBundles.isPending ||
    bundleGc.isPending;

  const run = async (a: GcAction) => {
    try {
      if (a === 'gc') {
        const started = await gc.mutateAsync();
        setTaskId(started.id);
      } else if (a === 'reconcile') {
        const started = await reconcile.mutateAsync();
        setTaskId(started.id);
      } else if (a === 'avatars') {
        const r = await avatars.mutateAsync();
        toast.success(t('media.avatarsDone', { files: r.sweptFiles }));
      } else {
        const inspected = await inspectBundles.mutateAsync();
        if (inspected.orphanBundles === 0) {
          toast.success(t('media.forwardBundlesNone'));
        } else {
          const r = await bundleGc.mutateAsync();
          toast.success(
            t('media.forwardBundlesDone', {
              bundles: r.orphanBundles,
              assets: r.orphanAssets,
            }),
          );
        }
      }
    } catch (e) {
      toast.error(formatApiError(e));
    }
    setPending(null);
  };

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
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPending('gc')}
            >
              {t('media.gc')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPending('avatars')}
            >
              {t('media.gcAvatars')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPending('forwardBundles')}
            >
              {t('media.gcForwardBundles')}
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
            <MetricTile
              label={t('media.tileAssets')}
              value={String(data.db.assetCount)}
              sub={t('media.assetStatusHint', {
                ready: data.db.ready,
                pending: data.db.pending,
                deleting: data.db.deleting,
                deleted: data.db.deleted,
                stalePending: data.db.stalePending,
                staleDeleting: data.db.staleDeleting,
              })}
            />
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

          {taskId ? (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>{t('media.taskTitle')}</CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">
                    {task &&
                    ['completed', 'cancelled', 'failed'].includes(task.status)
                      ? task.status
                      : connected
                        ? t('media.taskConnected')
                        : t('media.taskReconnecting')}
                  </Badge>
                  {task && ['running', 'cancelling'].includes(task.status) ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={
                        task.status === 'cancelling' || cancelTask.isPending
                      }
                      onClick={() => cancelTask.mutate(task.id)}
                    >
                      {task.status === 'cancelling'
                        ? t('media.taskCancelling')
                        : t('media.taskCancel')}
                    </Button>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {task ? (
                  <>
                    <div className="grid gap-3 text-sm md:grid-cols-2 lg:grid-cols-4">
                      <MetricTile
                        label={t('media.taskPhase')}
                        value={task.phase}
                      />
                      <MetricTile
                        label={t('media.taskScanned')}
                        value={String(task.scannedFiles)}
                        sub={formatBytes(Number(task.scannedBytes))}
                      />
                      <MetricTile
                        label={t('media.taskDeleted')}
                        value={String(task.deletedFiles)}
                        sub={formatBytes(Number(task.deletedBytes))}
                      />
                      <MetricTile
                        label={t('media.taskCurrentSize')}
                        value={
                          task.fileSize
                            ? formatBytes(Number(task.fileSize))
                            : '—'
                        }
                      />
                    </div>
                    <div className="rounded-md border px-3 py-2 font-mono text-xs">
                      <div className="text-muted-foreground">
                        {task.directory ?? '—'}
                      </div>
                      <div className="break-all">{task.file ?? '—'}</div>
                    </div>
                    {task.error ? (
                      <div className="text-sm text-destructive">
                        {task.error}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <Skeleton className="h-24 w-full" />
                )}
                <div
                  ref={taskLogPanel}
                  className="max-h-64 overflow-auto rounded-md border bg-muted/20 py-1"
                >
                  {taskLogs.lines.length ? (
                    taskLogs.lines.map((line, index) => (
                      <LogLine
                        key={`${String(line.time)}-${index}`}
                        rec={line}
                      />
                    ))
                  ) : (
                    <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                      {t('media.taskNoLogs')}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t('media.byExt')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('media.col.ext')}</TableHead>
                    <TableHead className="w-24">
                      {t('media.col.files')}
                    </TableHead>
                    <TableHead className="w-32">
                      {t('media.col.bytes')}
                    </TableHead>
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
                          <Badge
                            variant="outline"
                            className="font-mono text-xs"
                          >
                            {b.ext}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {b.files}
                        </TableCell>
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

          {isSuper ? (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle>{t('media.uploadManagementTitle')}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('media.uploadManagementDesc')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    resumableUploads.isFetching || pendingAssets.isFetching
                  }
                  onClick={() =>
                    void Promise.all([
                      resumableUploads.refetch(),
                      pendingAssets.refetch(),
                    ])
                  }
                >
                  {(resumableUploads.isFetching ||
                    pendingAssets.isFetching) && (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  )}
                  {t('media.uploadRefresh')}
                </Button>
              </CardHeader>
              <CardContent className="space-y-8">
                <section className="space-y-3">
                  <h3 className="font-medium">
                    {t('media.uploadSessionsTitle')}
                  </h3>
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
                        loading={resumableUploads.isLoading}
                        error={resumableUploads.error}
                        empty={!resumableUploads.data?.length}
                        colSpan={5}
                        emptyMessage={t('media.uploadSessionsEmpty')}
                      >
                        {resumableUploads.data?.map((upload) => {
                          const percent =
                            upload.totalBytes > 0
                              ? Math.min(
                                  100,
                                  Math.floor(
                                    (upload.offset / upload.totalBytes) * 100,
                                  ),
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
                              <TableCell className="tabular-nums">
                                #{upload.creatorId}
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <Badge variant="outline">
                                    {upload.status}
                                  </Badge>
                                  <span className="tabular-nums">
                                    {percent}%
                                  </span>
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
                                      await abortUpload.mutateAsync(
                                        upload.uploadId,
                                      );
                                      toast.success(t('media.uploadAborted'));
                                    } catch (e) {
                                      toast.error(formatApiError(e));
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
                </section>

                <section className="space-y-3 border-t pt-6">
                  <div>
                    <h3 className="font-medium">{t('media.pendingTitle')}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t('media.pendingDesc')}
                    </p>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Digest</TableHead>
                        <TableHead>{t('media.col.bytes')}</TableHead>
                        <TableHead>{t('media.pendingSince')}</TableHead>
                        <TableHead className="w-32" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableBodyState
                        loading={pendingAssets.isLoading}
                        error={pendingAssets.error}
                        empty={!pendingAssets.data?.length}
                        colSpan={4}
                        emptyMessage={t('media.pendingEmpty')}
                      >
                        {pendingAssets.data?.map((asset) => (
                          <TableRow key={asset.digest}>
                            <TableCell className="max-w-72 truncate font-mono text-xs">
                              {asset.digest}
                            </TableCell>
                            <TableCell>
                              {formatBytes(Number(asset.bytes))}
                            </TableCell>
                            <TableCell>
                              {new Date(asset.stateChangedAt).toLocaleString()}
                            </TableCell>
                            <TableCell>
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={terminatePending.isPending}
                                onClick={() => {
                                  if (
                                    !window.confirm(
                                      t('media.pendingTerminateConfirm'),
                                    )
                                  )
                                    return;
                                  terminatePending.mutate(asset.digest);
                                }}
                              >
                                {t('media.pendingTerminate')}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBodyState>
                    </TableBody>
                  </Table>
                </section>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}

      <Dialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
      >
        {pending ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(`media.confirmTitle.${pending}`)}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {t(`media.confirmBody.${pending}`)}
            </p>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setPending(null)}
              >
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
  );
}
