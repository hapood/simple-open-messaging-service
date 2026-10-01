import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, X } from 'lucide-react';
import type { MessageTarget } from '@/api/message-reports';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/common/pagination';
import { TableBodyState } from '@/components/common/table-state';
import { Timestamp } from '@/components/common/timestamp';
import {
  useMessageReports,
  useDismissMessageReport,
  useDeleteReportedMessages,
} from '@/hooks/use-message-reports';
import { useIsAdminPlus } from '@/hooks/use-me';
import { toast } from 'sonner';

const PAGE_SIZE = 20;
const targetKey = (target: MessageTarget) => `${target.threadId}:${target.seq}`;

export function MessageReportsPage() {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [isDeleted, setIsDeleted] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<{
    targets: MessageTarget[];
    action: 'DELETE' | 'DISMISS';
  } | null>(null);
  const query = useMessageReports({
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE,
    isDeleted,
  });
  const dismiss = useDismissMessageReport();
  const deletion = useDeleteReportedMessages();
  const canManage = useIsAdminPlus();
  const busy = dismiss.isPending || deletion.isPending;
  const filterItems = {
    ACTIVE: t('messageReports.active'),
    REMOVED: t('messageReports.removed'),
  };
  const selectable = (query.data?.list ?? []).filter(
    (report) => !report.message.isDeleted,
  );
  const selectedTargets = selectable
    .filter((report) => selected.has(targetKey(report)))
    .map(({ threadId, seq }) => ({ threadId, seq }));

  const confirm = () => {
    if (!target || busy) return;
    if (target.action === 'DISMISS') {
      dismiss.mutate(target.targets[0], {
        onSuccess: () => {
          toast.success(t('messageReports.dismissed'));
          setTarget(null);
        },
        onError: () => toast.error(t('messageReports.actionFailed')),
      });
      return;
    }
    deletion.mutate(target.targets, {
      onSuccess: ({ deleted, failed }) => {
        if (deleted)
          toast.success(
            t('messageReports.messagesDeleted', { count: deleted }),
          );
        setSelected(new Set(failed.map(targetKey)));
        if (failed.length) {
          toast.error(
            t('messageReports.deletionFailed', { count: failed.length }),
          );
          setTarget({ targets: failed, action: 'DELETE' });
        } else setTarget(null);
      },
      onError: () => toast.error(t('messageReports.actionFailed')),
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t('messageReports.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('messageReports.subtitle')}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Select
          value={isDeleted ? 'REMOVED' : 'ACTIVE'}
          onValueChange={(value) => {
            setIsDeleted(value === 'REMOVED');
            setPage(0);
            setSelected(new Set());
          }}
          items={filterItems}
        >
          <SelectTrigger
            className="w-48"
            aria-label={t('messageReports.filter')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ACTIVE">{t('messageReports.active')}</SelectItem>
            <SelectItem value="REMOVED">
              {t('messageReports.removed')}
            </SelectItem>
          </SelectContent>
        </Select>
        {canManage && (
          <Button
            variant="destructive"
            disabled={
              busy || query.isPlaceholderData || !selectedTargets.length
            }
            onClick={() =>
              setTarget({ targets: selectedTargets, action: 'DELETE' })
            }
          >
            {t('messageReports.deleteSelected', {
              count: selectedTargets.length,
            })}
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                {canManage && (
                  <input
                    type="checkbox"
                    aria-label={t('messageReports.selectAll')}
                    disabled={
                      busy || query.isPlaceholderData || !selectable.length
                    }
                    checked={
                      !!selectable.length &&
                      selectedTargets.length === selectable.length
                    }
                    onChange={(event) =>
                      setSelected(
                        new Set(
                          event.target.checked ? selectable.map(targetKey) : [],
                        ),
                      )
                    }
                  />
                )}
              </TableHead>
              <TableHead>{t('messageReports.message')}</TableHead>
              <TableHead>{t('messageReports.creator')}</TableHead>
              <TableHead>{t('messageReports.thread')}</TableHead>
              <TableHead>{t('messageReports.updatedAt')}</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={query.isLoading}
              error={query.error}
              empty={(query.data?.list.length ?? 0) === 0}
              colSpan={6}
              emptyMessage={t('messageReports.empty')}
            >
              {query.data?.list.map((report) => (
                <TableRow key={targetKey(report)}>
                  <TableCell>
                    {canManage && !report.message.isDeleted && (
                      <input
                        type="checkbox"
                        aria-label={t('messageReports.selectMessage', {
                          seq: report.seq,
                        })}
                        disabled={busy || query.isPlaceholderData}
                        checked={selected.has(targetKey(report))}
                        onChange={(event) =>
                          setSelected((previous) => {
                            const next = new Set(previous);
                            if (event.target.checked)
                              next.add(targetKey(report));
                            else next.delete(targetKey(report));
                            return next;
                          })
                        }
                      />
                    )}
                  </TableCell>
                  <TableCell className="max-w-96">
                    <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-[20px]">
                      {report.message.isDeleted
                        ? t('messageReports.deleted')
                        : report.message.content}
                    </pre>
                    <div className="font-mono text-xs text-muted-foreground">
                      seq {report.seq} · {report.message.contentType}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{report.creator.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {report.creator.account} · ns {report.creator.namespaceId}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {report.threadType} #{report.threadId}
                  </TableCell>
                  <TableCell>
                    <Timestamp value={report.updatedAt} />
                  </TableCell>
                  <TableCell>
                    {canManage && (
                      <div className="flex gap-1">
                        {!report.message.isDeleted && (
                          <Button
                            size="icon"
                            variant="destructive"
                            title={t('messageReports.deleteMessage')}
                            disabled={busy || query.isPlaceholderData}
                            onClick={() =>
                              setTarget({
                                targets: [
                                  {
                                    threadId: report.threadId,
                                    seq: report.seq,
                                  },
                                ],
                                action: 'DELETE',
                              })
                            }
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                        {!report.isDeleted && (
                          <Button
                            size="icon"
                            variant="outline"
                            title={t('messageReports.dismiss')}
                            disabled={busy || query.isPlaceholderData}
                            onClick={() =>
                              setTarget({
                                targets: [
                                  {
                                    threadId: report.threadId,
                                    seq: report.seq,
                                  },
                                ],
                                action: 'DISMISS',
                              })
                            }
                          >
                            <X className="size-4" />
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBodyState>
          </TableBody>
        </Table>
      </div>
      <div className="flex justify-end">
        <Pagination
          page={page}
          total={query.data?.total ?? 0}
          pageSize={PAGE_SIZE}
          onPageChange={(value) => {
            setPage(value);
            setSelected(new Set());
          }}
        />
      </div>
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(
                target?.action === 'DELETE'
                  ? 'messageReports.deleteConfirm'
                  : 'messageReports.dismissConfirm',
              )}
            </DialogTitle>
            <DialogDescription>
              {target?.action === 'DELETE'
                ? t('messageReports.deleteConfirmBody', {
                    count: target.targets.length,
                  })
                : t('messageReports.dismissConfirmBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setTarget(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant={target?.action === 'DELETE' ? 'destructive' : 'default'}
              disabled={busy}
              onClick={confirm}
            >
              {t(
                target?.action === 'DELETE'
                  ? 'messageReports.deleteMessage'
                  : 'messageReports.dismiss',
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
