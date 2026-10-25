import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatApiError } from '@/lib/format-error';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Search } from 'lucide-react';
import {
  useAdminSessions,
  useRevokeAdminSession,
} from '@/hooks/use-admin-sessions';
import { useListParams } from '@/hooks/use-list-params';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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

export function AdminSessionsPage() {
  const { t } = useTranslation();
  const { searchInput, setSearchInput, search, page, setPage, skip, take } =
    useListParams({
      pageSize: PAGE_SIZE,
    });
  const { data, isLoading, error, refetch, isFetching } = useAdminSessions({
    skip,
    take,
    ip: search || undefined,
  });
  const total = data?.total ?? 0;
  const revoke = useRevokeAdminSession();
  const [selected, setSelected] = useState<{
    id: string;
    account: string;
  } | null>(null);
  const signOut = async () => {
    if (!selected) return;
    try {
      await revoke.mutateAsync(selected.id);
      setSelected(null);
      toast.success(t('adminSessions.revoked'));
    } catch (error) {
      toast.error(formatApiError(error));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="outline"
        className="self-start"
        disabled={isFetching}
        onClick={() => void refetch()}
      >
        {t('security.account.refresh')}
      </Button>
      <div className="flex items-center justify-between gap-4">
        <p className="max-w-xl text-sm text-muted-foreground">
          {t('adminSessions.desc', { count: total })}
        </p>
        <div className="relative w-60">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder={t('adminSessions.searchPlaceholder')}
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
              <TableHead>{t('adminSessions.col.admin')}</TableHead>
              <TableHead>{t('adminSessions.col.ua')}</TableHead>
              <TableHead>{t('adminSessions.col.ip')}</TableHead>
              <TableHead>{t('adminSessions.col.created')}</TableHead>
              <TableHead>{t('adminSessions.col.expires')}</TableHead>
              <TableHead>{t('security.account.lastActive')}</TableHead>
              <TableHead>{t('adminSessions.revoke')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={7}
              skeletonRows={6}
              emptyMessage={t('adminSessions.empty')}
            >
              {data?.list.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    <Badge variant="outline">
                      {s.admin?.account ?? '#' + s.adminId}
                    </Badge>
                    {s.isCurrent && (
                      <Badge className="ml-2">
                        {t('security.account.thisSession')}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell
                    className="max-w-[280px] truncate text-xs text-muted-foreground"
                    title={s.userAgent ?? ''}
                  >
                    {s.userAgent ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {s.ip ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Timestamp value={s.createdAt} />
                  </TableCell>
                  <TableCell>
                    <Timestamp value={s.expiresAt} />
                  </TableCell>
                  <TableCell>
                    <Timestamp value={s.lastAccessedAt} />
                  </TableCell>
                  <TableCell>
                    {s.canRevoke && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={revoke.isPending}
                        onClick={() =>
                          setSelected({
                            id: s.id,
                            account: s.admin?.account ?? `#${s.adminId}`,
                          })
                        }
                      >
                        {t('adminSessions.revoke')}
                      </Button>
                    )}
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
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('adminSessions.confirmTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm leading-[20px]">
            {t('adminSessions.confirmBody', {
              account: selected?.account ?? '',
            })}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={revoke.isPending}
              onClick={() => setSelected(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => void signOut()}
            >
              {t('adminSessions.revoke')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
