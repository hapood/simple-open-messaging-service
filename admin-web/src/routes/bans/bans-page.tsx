import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useBans, useUnban } from '@/hooks/use-bans';
import { useObservationTime } from '@/hooks/use-observation-time';
import { useListParams } from '@/hooks/use-list-params';
import { useIsAdminPlus } from '@/hooks/use-me';
import { formatApiError } from '@/lib/format-error';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Timestamp } from '@/components/common/timestamp';
import { BAN_LABEL_KEYS, groupRestrictions } from './ban-view';

export function BansPage() {
  const { t } = useTranslation();
  const bans = useBans();
  const unban = useUnban();
  const canManage = useIsAdminPlus();
  const now = useObservationTime();
  const { searchInput, setSearchInput, search } = useListParams({
    pageSize: 50,
  });
  const { accounts, ips } = groupRestrictions(bans.data ?? [], search, now);
  const [selected, setSelected] = useState<{
    scope: 'ip' | 'account';
    value: string;
  } | null>(null);
  const release = async () => {
    if (!selected) return;
    try {
      await unban.mutateAsync(
        selected.scope === 'ip'
          ? { ip: selected.value }
          : { account: selected.value },
      );
      setSelected(null);
      toast.success(t('bans.released'));
    } catch (error) {
      toast.error(formatApiError(error));
    }
  };
  const remaining = (until: number) =>
    t('bans.remainingMinutes', {
      count: Math.max(1, Math.ceil((until - now) / 60000)),
    });
  const releaseButton = (scope: 'ip' | 'account', value: string) =>
    canManage && (
      <Button
        variant="outline"
        size="sm"
        disabled={unban.isPending}
        onClick={() => setSelected({ scope, value })}
      >
        {t('bans.unban')}
      </Button>
    );
  return (
    <div className="flex flex-col gap-5 text-sm leading-[20px]">
      <div>
        <h1 className="text-2xl font-semibold leading-[32px]">
          {t('bans.title')}
        </h1>
        <p className="mt-1 text-muted-foreground">{t('bans.desc')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="w-full sm:w-72"
          aria-label={t('bans.search')}
          placeholder={t('bans.search')}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <Button
          variant="outline"
          disabled={bans.isFetching}
          onClick={() => void bans.refetch()}
        >
          {t('security.account.refresh')}
        </Button>
      </div>
      {bans.isLoading ? (
        <p role="status">{t('common.loading')}</p>
      ) : bans.error ? (
        <p role="alert" className="text-destructive">
          {t('common.loadFailed', { message: formatApiError(bans.error) })}
        </p>
      ) : (
        <>
          <section
            className="flex flex-col gap-3"
            aria-label={t('bans.accounts')}
          >
            <h2 className="font-semibold">
              {t('bans.accounts')}{' '}
              <span className="text-muted-foreground">{accounts.length}</span>
            </h2>
            {accounts.length === 0 ? (
              <p className="rounded-lg border p-4 text-muted-foreground">
                {t('bans.emptyAccounts')}
              </p>
            ) : (
              accounts.map(([account, entries]) => (
                <article key={account} className="min-w-0 rounded-lg border">
                  <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h3 className="break-all font-semibold">
                        {entries[0].userId != null ? (
                          <Link
                            className="text-primary hover:underline"
                            to={`/users/${entries[0].userId}`}
                          >
                            {account}
                          </Link>
                        ) : (
                          account
                        )}
                      </h3>
                      <Badge variant="secondary">
                        {t('bans.restrictionCount', { count: entries.length })}
                      </Badge>
                    </div>
                    {releaseButton('account', account)}
                  </header>
                  <div className="hidden grid-cols-[1fr_1fr_120px] gap-3 px-4 pt-3 text-muted-foreground sm:grid">
                    <span>{t('bans.col.type')}</span>
                    <span>{t('bans.col.until')}</span>
                    <span>{t('bans.col.remaining')}</span>
                  </div>
                  <ul className="divide-y px-4">
                    {entries.map((ban) => (
                      <li
                        key={ban.key}
                        className="grid grid-cols-1 items-center gap-2 py-3 sm:grid-cols-[1fr_1fr_120px] sm:gap-3"
                      >
                        <span>
                          <Badge
                            variant="outline"
                            className="border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                          >
                            {t(BAN_LABEL_KEYS[ban.type])}
                          </Badge>
                        </span>
                        <span className="text-muted-foreground">
                          <span className="sm:hidden">
                            {t('bans.col.until')} ·{' '}
                          </span>
                          <Timestamp value={ban.until} />
                        </span>
                        <span className="text-muted-foreground">
                          {remaining(ban.until)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))
            )}
          </section>
          <section className="flex flex-col gap-3" aria-label={t('bans.ips')}>
            <h2 className="font-semibold">
              {t('bans.ips')}{' '}
              <span className="text-muted-foreground">{ips.length}</span>
            </h2>
            <p className="text-muted-foreground">{t('bans.ipScope')}</p>
            {ips.length === 0 ? (
              <p className="rounded-lg border p-4 text-muted-foreground">
                {t('bans.emptyIps')}
              </p>
            ) : (
              <ul className="divide-y rounded-lg border px-4">
                {ips.map((ban) => (
                  <li
                    key={ban.key}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <span className="min-w-0 break-all font-mono">
                      {ban.value}
                    </span>
                    <span className="text-muted-foreground">
                      <Timestamp value={ban.until} /> · {remaining(ban.until)}
                    </span>
                    {releaseButton('ip', ban.value)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('bans.confirmTitle')}</DialogTitle>
          </DialogHeader>
          <p className="break-all font-medium leading-[20px]">
            {selected?.value}
          </p>
          <p className="leading-[20px]">
            {selected &&
              t(
                selected.scope === 'ip'
                  ? 'bans.confirmIp'
                  : 'bans.confirmAccount',
                { value: selected.value },
              )}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={unban.isPending}
              onClick={() => setSelected(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button disabled={unban.isPending} onClick={() => void release()}>
              {t('bans.release')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
