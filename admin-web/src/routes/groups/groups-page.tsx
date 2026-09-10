import { useTranslation } from 'react-i18next';
import { Globe, Search } from 'lucide-react';
import { useGroups } from '@/hooks/use-groups';
import { useListParams } from '@/hooks/use-list-params';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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

/** Group/thread observability. Every GROUP thread (local + federated) with its member count and
 *  federation origin. Read-only for now — dissolve/transfer are a follow-up. */
export function GroupsPage() {
  const { t } = useTranslation();
  const { searchInput, setSearchInput, search, page, setPage, skip, take } =
    useListParams({
      pageSize: PAGE_SIZE,
    });
  const { data, isLoading, error } = useGroups({
    skip,
    take,
    search: search || undefined,
  });
  const total = data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('groups.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('groups.desc')}</p>
        </div>
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder={t('groups.searchPlaceholder')}
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
              <TableHead>{t('groups.col.name')}</TableHead>
              <TableHead className="w-24">{t('groups.col.members')}</TableHead>
              <TableHead className="w-44">{t('groups.col.origin')}</TableHead>
              <TableHead className="w-44">{t('groups.col.created')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={4}
              emptyMessage={t('groups.empty')}
            >
              {data?.list.map((g) => (
                <TableRow key={g.id}>
                  <TableCell>
                    <div className="font-medium">{g.group?.name ?? '—'}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {g.group?.account ?? `#${g.id}`}
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {g.memberCount}
                  </TableCell>
                  <TableCell>
                    {g.originDomain ? (
                      <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                        <Globe className="size-3" />
                        {g.originDomain}
                      </span>
                    ) : (
                      <Badge variant="secondary">{t('groups.local')}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Timestamp value={g.createdAt} />
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
