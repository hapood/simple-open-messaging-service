import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { useDomainCommands } from '@/hooks/use-domain-commands';
import { useListParams } from '@/hooks/use-list-params';
import type { DomainCommandStatus } from '@/types/api';
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
  'SUCCEEDED',
  'REJECTED',
  'FAILED',
] as const;

function statusVariant(status: DomainCommandStatus) {
  if (status === 'FAILED') return 'destructive' as const;
  if (status === 'SUCCEEDED') return 'default' as const;
  if (status === 'PROCESSING') return 'secondary' as const;
  return 'outline' as const;
}

/** Durable command history for operational diagnosis and business traceability. */
export function DomainCommandPage() {
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
    ? (filter as DomainCommandStatus | '')
    : '';
  const { data, isLoading, error } = useDomainCommands({
    skip,
    take,
    search: search || undefined,
    status: status || undefined,
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('commands.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('commands.desc')}</p>
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
                ? t(`commands.status.${candidate}`)
                : t('commands.status.ALL')}
            </Button>
          ))}
        </div>
        <div className="relative w-80">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder={t('commands.searchPlaceholder')}
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
              <TableHead>{t('commands.col.status')}</TableHead>
              <TableHead>{t('commands.col.command')}</TableHead>
              <TableHead>{t('commands.col.aggregate')}</TableHead>
              <TableHead>{t('commands.col.actor')}</TableHead>
              <TableHead>{t('commands.col.timing')}</TableHead>
              <TableHead>{t('commands.col.details')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={6}
              emptyMessage={t('commands.empty')}
            >
              {data?.list.map((command) => (
                <TableRow key={command.id}>
                  <TableCell className="align-top">
                    <Badge variant={statusVariant(command.status)}>
                      {t(`commands.status.${command.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="font-mono text-xs">
                      {command.commandType}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      #{command.id}
                      {command.parentCommandId
                        ? ` · parent #${command.parentCommandId}`
                        : ''}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-80 align-top">
                    <Badge variant="outline" className="mb-1 text-[10px]">
                      {command.aggregateType}
                    </Badge>
                    <div
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={command.aggregateKey}
                    >
                      {command.aggregateKey}
                    </div>
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs">
                    {command.actorUserId ? `#${command.actorUserId}` : '—'}
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    <div>
                      <Timestamp value={command.createdAt} />
                    </div>
                    {command.completedAt ? (
                      <div className="text-muted-foreground">
                        {t('commands.completed')}:{' '}
                        <Timestamp value={command.completedAt} />
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-96 align-top text-xs">
                    {command.resultCode != null ? (
                      <div>
                        {t('commands.resultCode')}: {command.resultCode}
                      </div>
                    ) : null}
                    {command.progressCursor != null ? (
                      <div>
                        {t('commands.progressCursor')}: {command.progressCursor}
                      </div>
                    ) : null}
                    {command.lastError ? (
                      <div className="max-w-96 break-words text-destructive">
                        {command.lastError}
                      </div>
                    ) : null}
                    <details>
                      <summary className="cursor-pointer text-muted-foreground">
                        {t('commands.payload')}
                      </summary>
                      <pre className="mt-1 max-h-48 max-w-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px]">
                        {JSON.stringify(command.payload, null, 2)}
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
