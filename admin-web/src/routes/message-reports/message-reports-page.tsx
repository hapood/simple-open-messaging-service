import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import type {
  MessageReportListItem,
  MessageReportStatus,
} from '@/api/message-reports';
import { Badge } from '@/components/ui/badge';
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
  useResolveMessageReports,
} from '@/hooks/use-message-reports';
import { useIsAdminPlus } from '@/hooks/use-me';
import { toast } from 'sonner';

const PAGE_SIZE = 20;

function messageText(report: MessageReportListItem): string {
  if (report.message.contentType !== 'PURE_TEXT')
    return report.message.contentType;
  try {
    const parsed = JSON.parse(report.message.content) as { text?: unknown };
    return typeof parsed.text === 'string'
      ? parsed.text
      : report.message.content;
  } catch {
    return report.message.content;
  }
}

function statusVariant(status: MessageReportStatus) {
  if (status === 'UPHELD') return 'destructive' as const;
  if (status === 'REJECTED') return 'secondary' as const;
  return 'outline' as const;
}

function statusKey(status: MessageReportStatus) {
  if (status === 'UPHELD') return 'messageReports.upheld' as const;
  if (status === 'REJECTED') return 'messageReports.rejected' as const;
  return 'messageReports.pending' as const;
}

export function MessageReportsPage() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<MessageReportStatus | 'ALL'>('PENDING');
  const [target, setTarget] = useState<{
    report: MessageReportListItem;
    status: 'UPHELD' | 'REJECTED';
  } | null>(null);
  const query = useMessageReports({
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    ...(status === 'ALL' ? {} : { status }),
  });
  const resolve = useResolveMessageReports();
  const canResolve = useIsAdminPlus();

  const confirm = () => {
    if (!target) return;
    resolve.mutate(
      { reportIds: [target.report.id], status: target.status },
      {
        onSuccess: () => {
          toast.success(t('messageReports.resolved'));
          setTarget(null);
        },
        onError: () => toast.error(t('messageReports.resolveFailed')),
      },
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t('messageReports.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('messageReports.subtitle')}
        </p>
      </div>

      <div className="flex w-48">
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value as MessageReportStatus | 'ALL');
            setPage(1);
          }}
        >
          <SelectTrigger aria-label={t('messageReports.statusFilter')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="PENDING">
              {t('messageReports.pending')}
            </SelectItem>
            <SelectItem value="UPHELD">{t('messageReports.upheld')}</SelectItem>
            <SelectItem value="REJECTED">
              {t('messageReports.rejected')}
            </SelectItem>
            <SelectItem value="ALL">{t('common.all')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('messageReports.message')}</TableHead>
              <TableHead>{t('messageReports.creator')}</TableHead>
              <TableHead>{t('messageReports.reporter')}</TableHead>
              <TableHead>{t('messageReports.thread')}</TableHead>
              <TableHead>{t('messageReports.status')}</TableHead>
              <TableHead>{t('messageReports.createdAt')}</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={query.isLoading}
              error={query.error}
              empty={(query.data?.list.length ?? 0) === 0}
              colSpan={7}
              emptyMessage={t('messageReports.empty')}
            >
              {query.data?.list.map((report) => (
                <TableRow key={report.id}>
                  <TableCell className="max-w-80">
                    <div className="truncate" title={messageText(report)}>
                      {messageText(report)}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      seq {report.messageSeq} · {report.message.contentType}
                      {report.message.isDeleted
                        ? ` · ${t('messageReports.deleted')}`
                        : ''}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{report.creator.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {report.creator.account}@{report.creator.domain}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{report.reporter.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {report.reporter.account}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {report.threadType} #{report.threadId}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(report.status)}>
                      {t(statusKey(report.status))}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Timestamp value={report.createdAt} />
                  </TableCell>
                  <TableCell>
                    {canResolve && report.status !== 'UPHELD' && (
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="destructive"
                          title={t('messageReports.uphold')}
                          onClick={() =>
                            setTarget({ report, status: 'UPHELD' })
                          }
                        >
                          <Check className="size-4" />
                        </Button>
                        {report.status === 'PENDING' && (
                          <Button
                            size="icon"
                            variant="outline"
                            title={t('messageReports.reject')}
                            onClick={() =>
                              setTarget({ report, status: 'REJECTED' })
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
          onPageChange={setPage}
        />
      </div>

      <Dialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target?.status === 'UPHELD'
                ? t('messageReports.upholdConfirm')
                : t('messageReports.rejectConfirm')}
            </DialogTitle>
            <DialogDescription>
              {target?.status === 'UPHELD'
                ? t('messageReports.upholdConfirmBody')
                : t('messageReports.rejectConfirmBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={target?.status === 'UPHELD' ? 'destructive' : 'default'}
              disabled={resolve.isPending}
              onClick={confirm}
            >
              {target?.status === 'UPHELD'
                ? t('messageReports.uphold')
                : t('messageReports.reject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
