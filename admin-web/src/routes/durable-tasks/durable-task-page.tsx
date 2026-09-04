import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { useDurableTasks } from '@/hooks/use-durable-tasks';
import { useListParams } from '@/hooks/use-list-params';
import type { DurableTaskStatus } from '@/types/api';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
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

const PAGE_SIZE = 50;
const STATUS_FILTERS = [
  '',
  'PENDING',
  'PROCESSING',
  'ASYNC_PROCESSING',
  'SUCCEEDED',
  'REJECTED',
  'FAILED',
  'SUPERSEDED',
] as const;

function statusVariant(status: DurableTaskStatus) {
  if (status === 'FAILED') return 'destructive' as const;
  if (status === 'SUCCEEDED') return 'default' as const;
  if (status === 'PROCESSING' || status === 'ASYNC_PROCESSING')
    return 'secondary' as const;
  return 'outline' as const;
}

/** Durable task history for operational diagnosis and business traceability. */
export function DurableTaskPage() {
  const { t } = useTranslation();
  const {
    searchInput,
    setSearchInput,
    search,
    page,
    setPage,
    filter,
    setFilter,
    skip,
    take,
  } = useListParams({ pageSize: PAGE_SIZE, filterParam: 'status' });
  const status = STATUS_FILTERS.includes(
    filter as (typeof STATUS_FILTERS)[number],
  )
    ? (filter as DurableTaskStatus | '')
    : '';
  const { data, isLoading, error } = useDurableTasks({
    skip,
    take,
    search: search || undefined,
    status: status || undefined,
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('durableTasks.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('durableTasks.desc')}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((candidate) => (
            <Button
              key={candidate || 'all'}
              size="sm"
              variant={status === candidate ? 'default' : 'outline'}
              onClick={() => setFilter(candidate)}
            >
              {candidate
                ? t(`durableTasks.status.${candidate}`)
                : t('durableTasks.status.ALL')}
            </Button>
          ))}
        </div>
        <div className="relative w-80">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder={t('durableTasks.searchPlaceholder')}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('durableTasks.col.status')}</TableHead>
              <TableHead>{t('durableTasks.col.command')}</TableHead>
              <TableHead>{t('durableTasks.col.aggregate')}</TableHead>
              <TableHead>{t('durableTasks.col.actor')}</TableHead>
              <TableHead>{t('durableTasks.col.timing')}</TableHead>
              <TableHead>{t('durableTasks.col.details')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={6}
              emptyMessage={t('durableTasks.empty')}
            >
              {data?.list.map((task) => (
                <TableRow key={task.id}>
                  <TableCell className="align-top">
                    <Badge variant={statusVariant(task.status)}>
                      {t(`durableTasks.status.${task.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="font-mono text-xs">{task.taskType}</div>
                    <div className="text-xs text-muted-foreground">
                      #{task.id}
                      {task.parentTaskId
                        ? ` · parent #${task.parentTaskId}`
                        : ''}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-80 align-top">
                    <Badge variant="outline" className="mb-1 text-[10px]">
                      {task.kind} · {task.scopeType}
                    </Badge>
                    <div
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={task.scopeKey}
                    >
                      {task.scopeKey}
                    </div>
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs">
                    {task.actorUserId ? `#${task.actorUserId}` : '—'}
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    <div>
                      <Timestamp value={task.createdAt} />
                    </div>
                    {task.completedAt ? (
                      <div className="text-muted-foreground">
                        {t('durableTasks.completed')}:{' '}
                        <Timestamp value={task.completedAt} />
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-96 align-top text-xs">
                    {task.resultCode != null ? (
                      <div>
                        {t('durableTasks.resultCode')}: {task.resultCode}
                      </div>
                    ) : null}
                    {Object.keys(task.checkpoint).length > 0 ? (
                      <div>
                        {t('durableTasks.checkpoint')}:{' '}
                        {JSON.stringify(task.checkpoint)}
                      </div>
                    ) : null}
                    {task.lastError ? (
                      <div className="max-w-96 break-words text-destructive">
                        {task.lastError}
                      </div>
                    ) : null}
                    <details>
                      <summary className="cursor-pointer text-muted-foreground">
                        {t('durableTasks.payload')}
                      </summary>
                      <pre className="mt-1 max-h-48 max-w-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px]">
                        {JSON.stringify(task.payload, null, 2)}
                      </pre>
                    </details>
                  </TableCell>
                </TableRow>
              ))}
            </TableBodyState>
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-end text-sm text-muted-foreground">
        <Pagination
          page={page}
          total={data?.total ?? 0}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}
