import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import type { MediaUser } from '@/api/media';
import {
  useMediaCommand,
  useMediaDownloads,
  useMediaFiles,
  useMediaUploads,
  type MediaCommand,
} from '@/hooks/use-media';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { Pagination } from '@/components/common/pagination';
import { formatApiError } from '@/lib/format-error';

import { formatMediaBytes, MEDIA_PAGE_SIZE } from './media-format';

export function Digest({ value }: { value: string | null }) {
  const { t } = useTranslation();
  if (!value) return <span>{t('media.pendingDigest')}</span>;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-[32px] max-w-full px-1 font-mono text-xs leading-[20px]"
      title={value}
      aria-label={t('media.copyDigest')}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => toast.success(t('media.copied')),
          () => toast.error(t('media.copyFailed')),
        );
      }}
    >
      {value.slice(0, 12)}…{value.slice(-8)}
    </Button>
  );
}

export function MediaUsers({
  users,
  total = users.length,
}: {
  users: MediaUser[];
  total?: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="text-xs leading-[20px]">
      {users.length
        ? users.map((user) => (
            <div key={`${user.namespaceId}:${user.account}`}>
              {user.account} · ns #{user.namespaceId}
            </div>
          ))
        : t('media.noAssociation')}
      {total > users.length ? (
        <div>{t('media.moreUsers', { count: total - users.length })}</div>
      ) : null}
    </div>
  );
}

export function MediaStatus({ value }: { value: string }) {
  const { t } = useTranslation();
  const labels: Record<string, string> = {
    available: t('media.available'),
    reclaimed: t('media.reclaimed'),
    temporary: t('media.temporary'),
    pending: t('media.pending'),
    downloading: t('media.downloading'),
    failed: t('media.failed'),
    ready: t('media.ready'),
    queued: t('media.queued'),
    active: t('media.active'),
    UPLOADING: t('media.uploading'),
    COMPLETING: t('media.completing'),
    ABORTED: t('media.failed'),
    PENDING: t('media.pending'),
    DOWNLOADING: t('media.downloading'),
    SUCCEEDED: t('media.ready'),
    FAILED: t('media.failed'),
  };
  return (
    <Badge
      variant={
        ['failed', 'FAILED', 'ABORTED'].includes(value)
          ? 'destructive'
          : 'outline'
      }
    >
      {labels[value] ?? value}
    </Badge>
  );
}

function useCommand() {
  const { t } = useTranslation();
  const mutation = useMediaCommand();
  return {
    busy: mutation.isPending,
    run: async (command: MediaCommand, confirmation?: string) => {
      if (confirmation && !window.confirm(confirmation)) return;
      try {
        await mutation.mutateAsync(command);
        toast.success(t('media.operationDone'));
      } catch (error) {
        toast.error(formatApiError(error));
      }
    },
  };
}

function Frame({
  title,
  hint,
  toolbar,
  children,
  page,
  total,
  loading,
  onPageChange,
}: {
  title: string;
  hint: string;
  toolbar?: ReactNode;
  children: ReactNode;
  page: number;
  total: number;
  loading: boolean;
  onPageChange: (page: number) => void;
}) {
  return (
    <Card className="leading-[20px]">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-sm leading-[20px] text-muted-foreground">{hint}</p>
        {toolbar}
      </CardHeader>
      <CardContent>
        {children}
        <div className="mt-4 flex justify-end text-sm leading-[20px]">
          <Pagination
            page={page}
            total={total}
            pageSize={MEDIA_PAGE_SIZE}
            onPageChange={onPageChange}
            disabled={loading}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Headers() {
  const { t } = useTranslation();
  return (
    <TableHeader>
      <TableRow>
        <TableHead>Digest</TableHead>
        <TableHead>{t('media.user')}</TableHead>
        <TableHead>{t('media.size')}</TableHead>
        <TableHead>{t('media.status')}</TableHead>
        <TableHead>{t('media.actions')}</TableHead>
      </TableRow>
    </TableHeader>
  );
}

export function MediaFilesPanel({
  userId,
  temporary = false,
}: {
  userId?: number;
  temporary?: boolean;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [digest, setDigest] = useState('');
  const [status, setStatus] = useState<'' | 'available' | 'reclaimed'>('');
  const files = useMediaFiles(
    {
      skip: page * MEDIA_PAGE_SIZE,
      take: MEDIA_PAGE_SIZE,
      userId,
      digest: digest || undefined,
      status: status || undefined,
    },
    temporary,
  );
  const command = useCommand();
  return (
    <Frame
      title={temporary ? t('media.temporaryTitle') : t('media.filesTitle')}
      hint={temporary ? t('media.temporaryHint') : t('media.filesHint')}
      page={page}
      total={files.data?.total ?? 0}
      loading={files.isFetching}
      onPageChange={setPage}
      toolbar={
        <div className="flex flex-wrap items-center gap-2 text-sm leading-[20px]">
          <input
            aria-label={t('media.digestSearch')}
            placeholder={t('media.digestSearch')}
            autoCapitalize="off"
            value={digest}
            maxLength={64}
            className="h-[36px] rounded-md border bg-background px-3 leading-[20px]"
            onChange={(event) => {
              setDigest(
                event.target.value.toLowerCase().replace(/[^a-f0-9]/g, ''),
              );
              setPage(0);
            }}
          />
          {!temporary ? (
            <select
              aria-label={t('media.status')}
              value={status}
              className="h-[36px] rounded-md border bg-background px-2 leading-[20px]"
              onChange={(event) => {
                setStatus(event.target.value as typeof status);
                setPage(0);
              }}
            >
              <option value="">{t('media.allStatuses')}</option>
              <option value="available">{t('media.available')}</option>
              <option value="reclaimed">{t('media.reclaimed')}</option>
            </select>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void files.refetch()}
            disabled={files.isFetching}
          >
            {t('media.refresh')}
          </Button>
          <span>
            {t('media.totals', {
              count: files.data?.total ?? 0,
              bytes: formatMediaBytes(files.data?.bytes ?? '0'),
            })}
          </span>
        </div>
      }
    >
      <Table>
        <Headers />
        <TableBody>
          <TableBodyState
            loading={files.isLoading}
            error={files.error}
            empty={!files.data?.list.length}
            colSpan={5}
            emptyMessage={t('media.empty')}
          >
            {files.data?.list.map((file) => (
              <TableRow key={file.digest}>
                <TableCell>
                  <Digest value={file.digest} />
                </TableCell>
                <TableCell>
                  <MediaUsers users={file.users} total={file.userCount} />
                </TableCell>
                <TableCell>{formatMediaBytes(file.bytes)}</TableCell>
                <TableCell>
                  <MediaStatus value={file.status} />
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={command.busy || file.status === 'reclaimed'}
                    onClick={() =>
                      void command.run(
                        {
                          kind: temporary ? 'temporary-clean' : 'reclaim',
                          id: file.digest,
                        },
                        temporary
                          ? t('media.temporaryCleanConfirm')
                          : t('media.reclaimConfirm'),
                      )
                    }
                  >
                    {temporary ? t('media.clean') : t('media.reclaim')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBodyState>
        </TableBody>
      </Table>
    </Frame>
  );
}

export function MediaUploadsPanel({ userId }: { userId?: number }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const uploads = useMediaUploads({
    skip: page * MEDIA_PAGE_SIZE,
    take: MEDIA_PAGE_SIZE,
    userId,
  });
  const command = useCommand();
  return (
    <Frame
      title={t('media.uploadsTitle')}
      hint={t('media.uploadsHint')}
      page={page}
      total={uploads.data?.total ?? 0}
      loading={uploads.isFetching}
      onPageChange={setPage}
      toolbar={
        <span className="text-sm leading-[20px]">
          {t('media.totals', {
            count: uploads.data?.total ?? 0,
            bytes: formatMediaBytes(uploads.data?.bytes ?? '0'),
          })}
        </span>
      }
    >
      <Table>
        <Headers />
        <TableBody>
          <TableBodyState
            loading={uploads.isLoading}
            error={uploads.error}
            empty={!uploads.data?.list.length}
            colSpan={5}
            emptyMessage={t('media.empty')}
          >
            {uploads.data?.list.map((upload) => (
              <TableRow key={upload.uploadId}>
                <TableCell>
                  <Digest value={upload.digest} />
                </TableCell>
                <TableCell>
                  <Link to={`/users/${upload.userId}`}>#{upload.userId}</Link>
                </TableCell>
                <TableCell>
                  {formatMediaBytes(upload.bytesReceived)} /{' '}
                  {formatMediaBytes(upload.bytes)}
                </TableCell>
                <TableCell>
                  <MediaStatus value={upload.status} />
                </TableCell>
                <TableCell>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={command.busy}
                    onClick={() =>
                      void command.run(
                        { kind: 'upload-stop', id: upload.uploadId },
                        t('media.uploadStopConfirm'),
                      )
                    }
                  >
                    {t('media.stopAndClean')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBodyState>
        </TableBody>
      </Table>
    </Frame>
  );
}

export function MediaDownloadsPanel({ userId }: { userId?: number }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState('');
  const downloads = useMediaDownloads({
    skip: page * MEDIA_PAGE_SIZE,
    take: MEDIA_PAGE_SIZE,
    userId,
    status: status || undefined,
  });
  const command = useCommand();
  return (
    <Frame
      title={t('media.downloadsTitle')}
      hint={t('media.downloadsHint')}
      page={page}
      total={downloads.data?.total ?? 0}
      loading={downloads.isFetching}
      onPageChange={setPage}
      toolbar={
        <select
          aria-label={t('media.status')}
          value={status}
          className="h-[36px] w-fit rounded-md border bg-background px-2 text-sm leading-[20px]"
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(0);
          }}
        >
          <option value="">{t('media.allStatuses')}</option>
          <option value="pending">{t('media.pending')}</option>
          <option value="downloading">{t('media.downloading')}</option>
          <option value="failed">{t('media.failed')}</option>
          <option value="ready">{t('media.ready')}</option>
        </select>
      }
    >
      <Table>
        <Headers />
        <TableBody>
          <TableBodyState
            loading={downloads.isLoading}
            error={downloads.error}
            empty={!downloads.data?.list.length}
            colSpan={5}
            emptyMessage={t('media.empty')}
          >
            {downloads.data?.list.map((batch) => (
              <TableRow key={batch.batchId}>
                <TableCell>
                  {batch.files.length
                    ? batch.files.map((file) => (
                        <div key={file.digest}>
                          <Digest value={file.digest} />
                        </div>
                      ))
                    : t('media.detailsNotRetained')}
                </TableCell>
                <TableCell>
                  <MediaUsers users={batch.users} />
                </TableCell>
                <TableCell>
                  {batch.bytesTotal === null
                    ? t('media.unknownBytes')
                    : `${formatMediaBytes(batch.bytesReceived)} / ${formatMediaBytes(batch.bytesTotal)}`}
                  <div className="text-xs leading-[20px]">
                    {batch.completedFiles ?? '—'} / {batch.totalFiles}{' '}
                    {t('media.filesUnit')}
                  </div>
                </TableCell>
                <TableCell>
                  <MediaStatus value={batch.status} />
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    {['pending', 'downloading'].includes(batch.status) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={command.busy}
                        onClick={() =>
                          void command.run(
                            { kind: 'download-stop', id: batch.batchId },
                            t('media.downloadStopConfirm'),
                          )
                        }
                      >
                        {t('media.stop')}
                      </Button>
                    ) : null}
                    {batch.status === 'failed' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={command.busy}
                        onClick={() =>
                          void command.run({
                            kind: 'download-retry',
                            id: batch.batchId,
                          })
                        }
                      >
                        {t('media.retry')}
                      </Button>
                    ) : null}
                    {['failed', 'ready'].includes(batch.status) ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={command.busy}
                        onClick={() =>
                          void command.run(
                            { kind: 'download-clean', id: batch.batchId },
                            t('media.downloadCleanConfirm'),
                          )
                        }
                      >
                        {t('media.clean')}
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBodyState>
        </TableBody>
      </Table>
    </Frame>
  );
}
