import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useIsSuperAdmin } from '@/hooks/use-me';
import { useDownloaderStream } from '@/hooks/use-downloader-stream';
import { useMediaCommand } from '@/hooks/use-media';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/common/pagination';
import { formatApiError } from '@/lib/format-error';
import {
  Digest,
  MediaDownloadsPanel,
  MediaFilesPanel,
  MediaStatus,
  MediaUploadsPanel,
  MediaUsers,
} from './media-tables';
import { formatMediaBytes, MEDIA_PAGE_SIZE } from './media-format';

function DownloaderPanel() {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const { snapshot, state } = useDownloaderStream(page, MEDIA_PAGE_SIZE);
  const command = useMediaCommand();
  const labels = {
    connecting: t('media.connecting'),
    open: t('media.connected'),
    reconnecting: t('media.reconnecting'),
    closed: t('media.disconnected'),
  };
  return (
    <Card className="leading-[20px]">
      <CardHeader>
        <CardTitle>{t('media.downloaderTitle')}</CardTitle>
        <p className="text-sm leading-[20px] text-muted-foreground">
          {t('media.downloaderHint')}
        </p>
        <div role="status" className="text-sm leading-[20px]">
          {labels[state]}
        </div>
        {snapshot ? (
          <div className="text-sm leading-[20px]">
            {t('media.runtimeCounts', {
              active: snapshot.active,
              limit: snapshot.limits.global,
              queued: snapshot.queued,
              peer: snapshot.limits.perPeer,
            })}
            <div className="text-xs leading-[20px] text-muted-foreground">
              {t('media.instance')}: {snapshot.instanceId} ·{' '}
              {new Date(snapshot.observedAt).toLocaleTimeString()}
            </div>
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Digest</TableHead>
              <TableHead>{t('media.user')}</TableHead>
              <TableHead>{t('media.size')}</TableHead>
              <TableHead>{t('media.status')}</TableHead>
              <TableHead>{t('media.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshot?.list.map((entry, index) => (
              <TableRow key={`${entry.digest}:${index}`}>
                <TableCell>
                  <Digest value={entry.digest} />
                </TableCell>
                <TableCell>
                  <MediaUsers users={entry.users} total={entry.userCount} />
                </TableCell>
                <TableCell>
                  {formatMediaBytes(entry.bytesReceived)} /{' '}
                  {formatMediaBytes(entry.bytesTotal)}
                </TableCell>
                <TableCell>
                  <MediaStatus value={entry.status} />
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state !== 'open' || command.isPending}
                    onClick={async () => {
                      if (!window.confirm(t('media.physicalStopConfirm')))
                        return;
                      try {
                        await command.mutateAsync({
                          kind: 'physical-stop',
                          id: entry.digest,
                        });
                        toast.success(t('media.operationDone'));
                      } catch (error) {
                        toast.error(formatApiError(error));
                      }
                    }}
                  >
                    {t('media.stop')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {snapshot && !snapshot.list.length ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center">
                  {t('media.empty')}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
        <div className="mt-4 flex justify-end text-sm leading-[20px]">
          <Pagination
            page={page}
            total={snapshot?.total ?? 0}
            pageSize={MEDIA_PAGE_SIZE}
            onPageChange={setPage}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export function MediaPage() {
  const { t } = useTranslation();
  const isSuper = useIsSuperAdmin();
  const [tab, setTab] = useState<
    'files' | 'downloader' | 'downloads' | 'uploads' | 'temporary'
  >('files');
  if (!isSuper) return <p className="leading-[20px]">{t('media.superOnly')}</p>;
  const tabs = [
    ['files', t('media.filesTitle')],
    ['downloader', t('media.downloaderTitle')],
    ['downloads', t('media.downloadsTitle')],
    ['uploads', t('media.uploadsTitle')],
    ['temporary', t('media.temporaryTitle')],
  ] as const;
  return (
    <div className="flex flex-col gap-4 leading-[20px]">
      <div>
        <h1 className="text-2xl font-semibold leading-[32px]">
          {t('media.title')}
        </h1>
        <p className="mt-2 text-sm leading-[20px] text-muted-foreground">
          {t('media.desc')}
        </p>
      </div>
      <nav className="flex flex-wrap gap-2" aria-label={t('media.title')}>
        {tabs.map(([value, label]) => (
          <Button
            key={value}
            variant={tab === value ? 'default' : 'outline'}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </Button>
        ))}
      </nav>
      {tab === 'files' ? (
        <MediaFilesPanel key="files" />
      ) : tab === 'temporary' ? (
        <MediaFilesPanel key="temporary" temporary />
      ) : tab === 'downloader' ? (
        <DownloaderPanel />
      ) : tab === 'downloads' ? (
        <MediaDownloadsPanel />
      ) : (
        <MediaUploadsPanel />
      )}
    </div>
  );
}
