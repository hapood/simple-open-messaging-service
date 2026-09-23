import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { KeyRound, MoreHorizontal, Plus, Search } from 'lucide-react';
import { useAdminUsers } from '@/hooks/use-admin-users';
import { useListParams } from '@/hooks/use-list-params';
import { useIsAdminPlus } from '@/hooks/use-me';
import {
  useBatchUsers,
  useDisableUser,
  useEnableUser,
  useForceLogoutUser,
} from '@/hooks/use-user-mutations';
import type { UserBatchAction } from '@/api/users';
import type { User } from '@/types/api';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Pagination } from '@/components/common/pagination';
import { TableBodyState } from '@/components/common/table-state';
import { Timestamp } from '@/components/common/timestamp';
import { SessionsDialog } from './sessions-dialog';
import { CreateUserDialog } from './create-user-dialog';
import { IssueLoginCodeDialog } from './issue-login-code-dialog';
import { GenerateInitialPasswordDialog } from './generate-initial-password-dialog';

const PAGE_SIZE = 20;

export function UsersPage() {
  const { t } = useTranslation();
  const canManage = useIsAdminPlus();
  const [sessionsUser, setSessionsUser] = useState<User | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [issueUser, setIssueUser] = useState<User | null>(null);
  const [genPwdUser, setGenPwdUser] = useState<User | null>(null);

  const { searchInput, setSearchInput, search, page, setPage, skip, take } =
    useListParams({
      pageSize: PAGE_SIZE,
    });

  const { data, isLoading, isFetching, error } = useAdminUsers({
    skip,
    take,
    search: search || undefined,
  });

  const disable = useDisableUser();
  const enable = useEnableUser();
  const forceLogout = useForceLogoutUser();
  const batch = useBatchUsers();

  useEffect(() => {
    if (searchParams.get('create') === '1' && canManage) setCreateOpen(true);
  }, [searchParams, canManage]);

  const closeCreate = () => {
    setCreateOpen(false);
    if (searchParams.has('create')) {
      const next = new URLSearchParams(searchParams);
      next.delete('create');
      setSearchParams(next, { replace: true });
    }
  };

  const onAction = async (
    m: { mutateAsync: (id: number) => Promise<void> },
    id: number,
    msg: string,
  ) => {
    try {
      await m.mutateAsync(id);
      toast.success(msg);
    } catch {
      /* Global mutation onError already shows a toast. */
    }
  };

  const total = data?.total ?? 0;

  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Clear the selection whenever the view changes (search/page) so we never act on stale ids.
  useEffect(() => {
    setSelected(new Set());
  }, [search, page]);

  const listIds = (data?.list ?? [])
    .filter((u) => u.domain === 'local')
    .map((u) => u.id);
  const allSelected =
    listIds.length > 0 && listIds.every((id) => selected.has(id));
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) listIds.forEach((id) => next.delete(id));
      else listIds.forEach((id) => next.add(id));
      return next;
    });

  const onBatch = async (action: UserBatchAction) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      const r = await batch.mutateAsync({ ids, action });
      toast.success(t('users.toast.batchDone', { count: r.affected }));
      setSelected(new Set());
    } catch {
      /* Global mutation onError already shows a toast. */
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-4">
        <div className="flex items-center gap-2">
          <div className="relative w-72">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              type="search"
              aria-label={t('users.searchPlaceholder')}
              placeholder={t('users.searchPlaceholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-8"
            />
          </div>
          {canManage ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('users.create')}
            </Button>
          ) : null}
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span>{t('users.selected', { count: selected.size })}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={batch.isPending}
            onClick={() => onBatch('force-logout')}
          >
            {t('users.action.forceLogout')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive"
            disabled={batch.isPending}
            onClick={() => onBatch('disable')}
          >
            {t('users.action.ban')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={batch.isPending}
            onClick={() => onBatch('enable')}
          >
            {t('users.action.unban')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(new Set())}
          >
            {t('common.cancel')}
          </Button>
        </div>
      ) : null}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label={t('users.selectAll')}
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={(data?.list.length ?? 0) === 0}
                  className="size-4"
                />
              </TableHead>
              <TableHead className="w-16">{t('users.col.id')}</TableHead>
              <TableHead>{t('users.col.account')}</TableHead>
              <TableHead>{t('users.col.domain')}</TableHead>
              <TableHead className="w-16">{t('users.col.foreigner')}</TableHead>
              <TableHead className="w-20">{t('users.col.status')}</TableHead>
              <TableHead className="w-28">{t('users.col.quota')}</TableHead>
              <TableHead>{t('users.col.createdAt')}</TableHead>
              <TableHead className="w-48 text-right">
                {t('users.col.actions')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={9}
            >
              {data?.list.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={t('users.selectRow', { name: u.account })}
                      checked={selected.has(u.id)}
                      onChange={() => toggle(u.id)}
                      disabled={u.domain !== 'local'}
                      className="size-4"
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {u.id}
                  </TableCell>
                  <TableCell className="font-medium">
                    <Link to={`/users/${u.id}`} className="hover:underline">
                      {u.account}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.domain ?? '—'}
                  </TableCell>
                  <TableCell>
                    {u.domain !== 'local' ? t('common.yes') : t('common.no')}
                  </TableCell>
                  <TableCell>
                    {u.isDeleted ? (
                      <Badge variant="destructive">
                        {t('users.status.banned')}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">
                        {t('users.status.active')}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {u.quota ? (
                      <div className="flex flex-wrap gap-1">
                        <Badge
                          variant={
                            u.quota.status === 'exhausted'
                              ? 'destructive'
                              : u.quota.status === 'warning'
                                ? 'outline'
                                : 'secondary'
                          }
                        >
                          {t(`quota.status.${u.quota.status}`)}
                        </Badge>
                        {u.quota.hasOverrides ? (
                          <Badge variant="outline">
                            {t('quota.source.userCustom')}
                          </Badge>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">
                        {t('quota.notApplicable')}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Timestamp value={u.createdAt} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {canManage && u.domain === 'local' && !u.isDeleted ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isFetching}
                          onClick={() => setIssueUser(u)}
                        >
                          <KeyRound className="size-4" />
                          {t('users.action.issueLoginCode')}
                        </Button>
                      ) : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          className={buttonVariants({
                            variant: 'ghost',
                            size: 'icon',
                          })}
                          disabled={isFetching}
                        >
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {u.domain === 'local' && u.isDeleted ? (
                            <DropdownMenuItem
                              onClick={() =>
                                onAction(
                                  enable,
                                  u.id,
                                  t('users.toast.unbanned'),
                                )
                              }
                            >
                              {t('users.action.unban')}
                            </DropdownMenuItem>
                          ) : u.domain === 'local' ? (
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() =>
                                onAction(disable, u.id, t('users.toast.banned'))
                              }
                            >
                              {t('users.action.ban')}
                            </DropdownMenuItem>
                          ) : null}
                          {u.domain === 'local' ? (
                            <DropdownMenuItem
                              onClick={() =>
                                onAction(
                                  forceLogout,
                                  u.id,
                                  t('users.toast.forceLoggedOut'),
                                )
                              }
                            >
                              {t('users.action.forceLogout')}
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem onClick={() => setSessionsUser(u)}>
                            {t('users.action.viewSessions')}
                          </DropdownMenuItem>
                          {canManage && u.domain === 'local' ? (
                            <>
                              <DropdownMenuItem
                                onClick={() => setGenPwdUser(u)}
                              >
                                {t('users.action.generateInitialPassword')}
                              </DropdownMenuItem>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBodyState>
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{t('users.total', { count: total })}</span>
        <Pagination
          page={page}
          total={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </div>

      <SessionsDialog
        user={sessionsUser}
        onClose={() => setSessionsUser(null)}
      />
      <CreateUserDialog open={createOpen} onClose={closeCreate} />
      <IssueLoginCodeDialog
        user={
          issueUser ? { id: issueUser.id, account: issueUser.account } : null
        }
        onClose={() => setIssueUser(null)}
      />
      <GenerateInitialPasswordDialog
        user={
          genPwdUser ? { id: genPwdUser.id, account: genPwdUser.account } : null
        }
        onClose={() => setGenPwdUser(null)}
      />
    </div>
  );
}
