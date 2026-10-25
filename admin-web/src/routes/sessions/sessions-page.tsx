import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAllSessions, usePurgeSessions } from '@/hooks/use-sessions';
import { useListParams } from '@/hooks/use-list-params';
import { useIsSuperAdmin } from '@/hooks/use-me';
import { formatApiError } from '@/lib/format-error';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Pagination } from '@/components/common/pagination';
import { SessionTable } from './session-table';

const PAGE_SIZE = 50;
export function SessionsPage() {
  const { t } = useTranslation();
  const isSuper = useIsSuperAdmin();
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const {
    searchInput,
    setSearchInput,
    search,
    page,
    setPage,
    skip,
    take,
    filter,
    setFilter,
  } = useListParams({ pageSize: PAGE_SIZE, filterParam: 'userId' });
  const client = params.get('client') ?? '';
  const userId = filter ? Number(filter) : undefined;
  const validUser =
    userId === undefined || (Number.isSafeInteger(userId) && userId > 0);
  const validClient = !client || ['app', 'web', 'desktop'].includes(client);
  const valid = validUser && validClient;
  const { data, isLoading, error } = useAllSessions(
    {
      skip,
      take,
      ip: search || undefined,
      userId,
      client: client || undefined,
    },
    valid,
  );
  const purge = usePurgeSessions();
  const total = data?.total ?? 0;
  const onPurge = async () => {
    try {
      const result = await purge.mutateAsync();
      toast.success(t('sessions.purged', { count: result.purgedUsers }));
      setPurgeOpen(false);
    } catch (error) {
      toast.error(formatApiError(error));
    }
  };
  return (
    <div className="flex flex-col gap-4 text-sm leading-[20px]">
      <p className="text-muted-foreground">
        {t('sessions.desc', { count: valid ? total : 0 })}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          {t('sessions.userFilter')}
          <Input
            type="number"
            min={1}
            step={1}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          {t('sessions.searchPlaceholder')}
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          {t('sessions.col.client')}
          <select
            className="h-9 rounded-md border bg-background px-3 leading-[20px]"
            value={client}
            onChange={(event) => {
              setParams(
                (previous) => {
                  const next = new URLSearchParams(previous);
                  if (event.target.value)
                    next.set('client', event.target.value);
                  else next.delete('client');
                  next.delete('p');
                  return next;
                },
                { replace: true },
              );
            }}
          >
            <option value="">{t('common.all')}</option>
            {(['app', 'web', 'desktop'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`common.client.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {isSuper && (
          <Button
            variant="destructive"
            disabled={total === 0}
            onClick={() => setPurgeOpen(true)}
          >
            {t('sessions.purge')}
          </Button>
        )}
      </div>
      {!valid ? (
        <p role="alert" className="text-destructive">
          {t('sessions.invalidFilters')}
        </p>
      ) : (
        <>
          <SessionTable
            sessions={data?.list ?? []}
            loading={isLoading}
            error={error}
            showUser
          />
          <Pagination
            page={page}
            total={total}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />
        </>
      )}
      <Dialog open={purgeOpen} onOpenChange={setPurgeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('sessions.purgeTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm leading-[20px] text-muted-foreground">
            {t('sessions.purgeBody')}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={purge.isPending}
              onClick={() => setPurgeOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={purge.isPending}
              onClick={() => void onPurge()}
            >
              {t('sessions.purgeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
