import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useBreakers } from '@/hooks/use-quota';
import { useIsSuperAdmin } from '@/hooks/use-me';
import { ContinueQuotaDialog } from '@/components/admin/continue-quota-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BreakerStatus } from '@/types/api';
import { formatApiError } from '@/lib/format-error';

export function QuotaOverviewPage() {
  const { t } = useTranslation();
  const query = useBreakers();
  const canManage = useIsSuperAdmin();
  const [selected, setSelected] = useState<BreakerStatus | null>(null);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('all');
  const entries = [...(query.data?.users ?? []), ...(query.data?.peers ?? [])];
  const filtered = entries.filter(
    (item) =>
      (scope === 'all' || item.scope === scope) &&
      item.entity.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">{t('quotaCenter.description')}</p>
      <div className="flex flex-wrap gap-4">
        <Link className="text-primary underline" to="/users">
          {t('nav.users')}
        </Link>
        <Link className="text-primary underline" to="/federation">
          {t('nav.federation')}
        </Link>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          className="w-64"
          aria-label={t('quotaCenter.search')}
          placeholder={t('quotaCenter.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="rounded border px-2 h-9 bg-background"
          aria-label={t('quotaCenter.scope')}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          {(['all', 'user', 'peer'] as const).map((value) => (
            <option key={value} value={value}>
              {t(`quotaCenter.${value}`)}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t('localInfo.refresh')}
        </Button>
      </div>
      {query.isPending && <p role="status">{t('common.loading')}</p>}
      {query.error && <p role="alert">{formatApiError(query.error)}</p>}
      {query.data && (
        <p>
          {t('quotaCenter.counts', {
            users: query.data.users.length,
            peers: query.data.peers.length,
          })}
        </p>
      )}
      {query.data && !query.error && !filtered.length && (
        <p>{t('quotaCenter.empty')}</p>
      )}
      {filtered.map((item) => (
        <article
          key={`${item.scope}:${item.entity}`}
          className="border rounded-lg p-4 space-y-2"
        >
          <Link
            className="font-mono text-primary underline break-all"
            to={
              item.scope === 'user'
                ? `/users/${encodeURIComponent(item.entity)}`
                : `/federation/${encodeURIComponent(item.entity)}`
            }
          >
            {t(`quotaCenter.${item.scope}`)} · {item.entity}
          </Link>
          <p>
            {t('quota.breaker.dimMsg')}: {item.msg.count} / {item.msg.limit} ·{' '}
            {t('quota.breaker.dimFile')}: {item.file.count} / {item.file.limit}
          </p>
          <p>
            {t('quota.breaker.dimFileBytes')}: {item.fileBytes.bytes} /{' '}
            {item.fileBytes.limit} B
          </p>
          <p>
            {t('quotaCenter.limitedDimensions')}:{' '}
            {item.trippedDims
              .map((dim) =>
                t(
                  `quota.breaker.dim${dim === 'msg' ? 'Msg' : dim === 'file' ? 'File' : 'FileBytes'}`,
                ),
              )
              .join(', ')}
          </p>
          {canManage && (
            <Button variant="outline" onClick={() => setSelected(item)}>
              {t('quota.breaker.review')}
            </Button>
          )}
        </article>
      ))}
      {selected && (
        <ContinueQuotaDialog
          breaker={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
