import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  getAuditActions,
  listAudit,
  type AuditQuery,
  type AuditStatus,
} from '@/api/audit';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Pagination } from '@/components/common/pagination';
import { Timestamp } from '@/components/common/timestamp';
import { AuditStatusBadge } from './audit-status-badge';
import { auditActionLabel } from './audit-action-label';

const PAGE_SIZE = 50;
const STATUSES: AuditStatus[] = ['STARTED', 'SUCCEEDED', 'FAILED'];
function defaultFrom() {
  return new Date(Date.now() - 7 * 86400000).toISOString();
}
function iso(value: string | null) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function localDate(value: string | null) {
  const parsed = iso(value);
  if (!parsed) return '';
  const date = new Date(parsed);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export function AuditPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams({ from: defaultFrom() });
  const [invalidRange, setInvalidRange] = useState(false);
  const initialized = useRef(false);
  // Persist the initial seven-day window too, so refreshes and shared URLs use the same bounds.
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setParams(new URLSearchParams(params), { replace: true });
  }, [params, setParams]);
  const rawPage = Number(params.get('page') ?? 0);
  const page =
    Number.isSafeInteger(rawPage) && rawPage >= 0 && rawPage <= 1000000
      ? rawPage
      : 0;
  const status = params.get('status') as AuditStatus | null;
  const actor = Number(params.get('adminId'));
  const query: AuditQuery = {
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE,
    action: params.get('action') || undefined,
    adminId: Number.isSafeInteger(actor) && actor > 0 ? actor : undefined,
    status: status && STATUSES.includes(status) ? status : undefined,
    from: iso(params.get('from')),
    to: iso(params.get('to')),
  };
  const validRange = !query.from || !query.to || query.from < query.to;
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['admin', 'audit', query],
    queryFn: () => listAudit(query),
    enabled: validRange,
  });
  const actions = useQuery({
    queryKey: ['admin', 'audit-actions'],
    queryFn: getAuditActions,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    for (const [key, value] of fields) {
      if (typeof value === 'string' && value.trim())
        next.set(key, value.trim());
    }
    const from = iso(next.get('from'));
    const to = iso(next.get('to'));
    if (from && to && from >= to) {
      setInvalidRange(true);
      return;
    }
    if (from) next.set('from', from);
    if (to) next.set('to', to);
    setInvalidRange(false);
    setParams(next);
  }

  return (
    <div className="flex flex-col gap-4 leading-[20px]">
      <header>
        <h1 className="text-2xl font-semibold leading-[32px]">
          {t('audit.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('audit.desc')}</p>
      </header>
      <form
        key={params.toString()}
        onSubmit={submit}
        className="flex flex-wrap items-end gap-3"
      >
        <label className="text-sm">
          {t('audit.action')}
          <Input
            name="action"
            autoCapitalize="off"
            maxLength={64}
            list="audit-actions"
            defaultValue={params.get('action') ?? ''}
            className="w-64"
          />
        </label>
        <datalist id="audit-actions">
          {actions.data?.actions.map((action) => (
            <option key={action} value={action}>
              {auditActionLabel(t, action)}
            </option>
          ))}
        </datalist>
        <label className="text-sm">
          {t('audit.actor')}
          <Input
            name="adminId"
            autoCapitalize="off"
            type="number"
            min="1"
            max="2147483647"
            step="1"
            defaultValue={params.get('adminId') ?? ''}
            className="w-36"
          />
        </label>
        <label className="flex flex-col text-sm">
          {t('audit.statusLabel')}
          <select
            name="status"
            defaultValue={query.status ?? ''}
            className="h-9 rounded-md border bg-background px-3 text-sm leading-[20px]"
          >
            <option value="">{t('audit.all')}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`audit.status.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          {t('audit.from')}
          <Input
            name="from"
            type="datetime-local"
            defaultValue={localDate(params.get('from'))}
          />
        </label>
        <label className="text-sm">
          {t('audit.to')}
          <Input
            name="to"
            type="datetime-local"
            defaultValue={localDate(params.get('to'))}
          />
        </label>
        <Button type="submit">{t('audit.query')}</Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setInvalidRange(false);
            setParams({ from: defaultFrom() });
          }}
        >
          {t('audit.reset')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={isFetching || !validRange}
          onClick={() => void refetch()}
        >
          {t('audit.refresh')}
        </Button>
      </form>
      {invalidRange || !validRange ? (
        <p role="alert" className="text-destructive">
          {t('audit.invalidRange')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {t('audit.loadError')}
        </p>
      ) : null}
      {isLoading ? <p role="status">{t('common.loading')}</p> : null}
      {validRange && !isLoading && !error && data?.list.length === 0 ? (
        <p>{t('audit.empty')}</p>
      ) : null}
      <div className="grid gap-3">
        {validRange &&
          data?.list.map((record) => (
            <Card key={record.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">
                      {auditActionLabel(t, record.action)}
                    </span>
                    <AuditStatusBadge status={record.status} />
                  </div>
                  <p className="mt-2 break-words text-sm text-muted-foreground">
                    {t('audit.actor')}: #{record.adminId} · {t('audit.target')}:{' '}
                    {record.targetType ?? '—'}{' '}
                    {record.targetLabel ?? record.targetId ?? '—'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <Timestamp value={record.createdAt} /> · #{record.id}
                  </p>
                </div>
                <Link
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  to={`/audit/${record.id}`}
                  state={{ auditSearch: params.toString() }}
                >
                  {t('audit.details')}
                </Link>
              </CardContent>
            </Card>
          ))}
      </div>
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={data?.total ?? 0}
        disabled={isFetching || !validRange}
        onPageChange={(next) => {
          const updated = new URLSearchParams(params);
          updated.set('page', String(next));
          setParams(updated);
        }}
      />
    </div>
  );
}
