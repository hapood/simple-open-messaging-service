import { useTranslation } from 'react-i18next';
import { CheckCircle2, Search, XCircle } from 'lucide-react';
import { useAudit } from '@/hooks/use-audit';
import { useListParams } from '@/hooks/use-list-params';
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
const SUCCESS_FILTERS = ['', 'true', 'false'] as const;

/** Admin action audit log viewer. URL-synced (action search + outcome filter + page). The outcome
 *  filter reuses useListParams' single filter slot as 'success' ('' = all, 'true'/'false'). */
export function AuditPage() {
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
  } = useListParams({ pageSize: PAGE_SIZE, filterParam: 'success' });

  const success =
    filter === 'true' ? true : filter === 'false' ? false : undefined;

  const { data, isLoading, error } = useAudit({
    skip,
    take,
    action: search || undefined,
    success,
  });

  const total = data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('audit.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('audit.desc')}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {SUCCESS_FILTERS.map((s) => (
            <Button
              key={s || 'all'}
              size="sm"
              variant={filter === s ? 'default' : 'outline'}
              onClick={() => setFilter(s)}
            >
              {s === ''
                ? t('audit.outcomeAll')
                : s === 'true'
                  ? t('audit.outcomeSuccess')
                  : t('audit.outcomeFailed')}
            </Button>
          ))}
        </div>
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder={t('audit.searchPlaceholder')}
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
              <TableHead className="w-8" />
              <TableHead>{t('audit.col.action')}</TableHead>
              <TableHead>{t('audit.col.target')}</TableHead>
              <TableHead className="w-32">{t('audit.col.actor')}</TableHead>
              <TableHead className="w-36">{t('audit.col.ip')}</TableHead>
              <TableHead className="w-44">{t('audit.col.at')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={6}
              emptyMessage={t('audit.empty')}
            >
              {data?.list.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    {a.success ? (
                      <CheckCircle2 className="size-4 text-emerald-500" />
                    ) : (
                      <span title={a.errorMessage ?? undefined}>
                        <XCircle className="size-4 text-destructive" />
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-mono text-xs">{a.action}</span>
                      <span
                        className="max-w-[320px] truncate text-xs text-muted-foreground"
                        title={a.route ?? ''}
                      >
                        {a.route ?? ''}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {a.targetType ? `${a.targetType}:` : ''}{' '}
                    {a.targetLabel ?? a.targetId ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {a.adminRole}
                    </Badge>
                    <span className="ml-1 text-xs text-muted-foreground">
                      #{a.adminId}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {a.ip ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Timestamp value={a.at} />
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
          total={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}
