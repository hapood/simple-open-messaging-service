import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  cleanGarbage,
  scanGarbage,
  type GarbageEntry,
  type GarbageScan,
} from '@/api/garbage';
import { useIsSuperAdmin } from '@/hooks/use-me';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatApiError } from '@/lib/format-error';
import { formatMediaBytes } from './media-format';

export function GarbagePage() {
  const { t } = useTranslation();
  const isSuper = useIsSuperAdmin();
  const [result, setResult] = useState<GarbageScan | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isSuper) return <p className="leading-[20px]">{t('media.superOnly')}</p>;
  const scan = async () => {
    setBusy(true);
    try {
      setResult(await scanGarbage());
    } catch (error) {
      toast.error(formatApiError(error));
    } finally {
      setBusy(false);
    }
  };
  const clean = async (entry: GarbageEntry) => {
    if (
      !window.confirm(
        t(
          entry.kind === 'directory'
            ? 'garbage.directoryConfirm'
            : 'garbage.confirm',
          { name: entry.name },
        ),
      )
    )
      return;
    setBusy(true);
    try {
      await cleanGarbage(entry.token, entry.kind === 'directory');
      setResult((current) =>
        current
          ? {
              ...current,
              list: current.list.filter((row) => row.token !== entry.token),
              total: current.total - 1,
            }
          : null,
      );
      toast.success(t('media.operationDone'));
    } catch (error) {
      toast.error(formatApiError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4 leading-[20px]">
      <h1 className="text-2xl font-semibold leading-[32px]">
        {t('nav.garbage')}
      </h1>
      <p className="text-sm leading-[20px]">{t('garbage.hint')}</p>
      <div>
        <Button disabled={busy} onClick={() => void scan()}>
          {t(busy ? 'common.loading' : 'garbage.scan')}
        </Button>
      </div>
      {result ? (
        <>
          <p role="status">
            {t('garbage.summary', {
              shown: result.list.length,
              total: result.total,
            })}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('garbage.entry')}</TableHead>
                <TableHead>{t('media.size')}</TableHead>
                <TableHead>{t('garbage.modified')}</TableHead>
                <TableHead>{t('garbage.owners')}</TableHead>
                <TableHead>{t('media.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.list.map((entry) => (
                <TableRow key={entry.token}>
                  <TableCell className="max-w-[480px] break-all leading-[20px]">
                    <div>
                      {entry.root === 'cas' ? 'cas/tmp' : 'resumable'} /{' '}
                      {entry.name}
                    </div>
                    <div>{t(`garbage.kind.${entry.kind}`)}</div>
                    {entry.kind !== 'directory'
                      ? entry.files.map((file) => (
                          <div
                            key={file}
                            className="text-xs leading-[16px] text-muted-foreground"
                          >
                            {file}
                          </div>
                        ))
                      : null}
                  </TableCell>
                  <TableCell>{formatMediaBytes(entry.bytes)}</TableCell>
                  <TableCell>
                    {new Date(entry.modifiedAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {entry.tasks.length
                      ? entry.tasks.map((task, index) => (
                          <div
                            key={`${task.id}:${index}`}
                            className="break-all leading-[20px]"
                          >
                            {task.id}: {task.status}
                          </div>
                        ))
                      : t('garbage.noOwner')}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy || !entry.canDelete}
                      onClick={() => void clean(entry)}
                    >
                      {t('common.delete')}
                    </Button>
                    {entry.blockedReason ? (
                      <p className="text-xs leading-[16px]">
                        {t(`garbage.blocked.${entry.blockedReason}`)}
                      </p>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      ) : (
        <p>{t('garbage.notScanned')}</p>
      )}
    </div>
  );
}
