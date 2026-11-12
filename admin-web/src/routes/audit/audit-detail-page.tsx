import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { getAuditDetail } from '@/api/audit';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Timestamp } from '@/components/common/timestamp';
import { AuditStatusBadge } from './audit-status-badge';
import { auditActionLabel } from './audit-action-label';

export function AuditDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const location = useLocation();
  const search = (location.state as { auditSearch?: unknown } | null)
    ?.auditSearch;
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'audit-detail', id],
    queryFn: () => getAuditDetail(id),
    retry: false,
  });
  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data!.meta, null, 2));
      toast.success(t('audit.copied'));
    } catch {
      toast.error(t('audit.copyFailed'));
    }
  }
  return (
    <div className="flex flex-col gap-4 leading-[20px]">
      <div className="flex items-center justify-between gap-3">
        <Link
          className={buttonVariants({ variant: 'outline' })}
          to={typeof search === 'string' ? `/audit?${search}` : '/audit'}
        >
          {t('audit.back')}
        </Link>
        <Button
          variant="outline"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          {t('audit.refresh')}
        </Button>
      </div>
      <h1 className="text-2xl font-semibold leading-[32px]">
        {t('audit.detailTitle')} #{id}
      </h1>
      {isLoading ? <p role="status">{t('common.loading')}</p> : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {t('audit.loadError')}
        </p>
      ) : null}
      {data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="leading-[24px]">
                <h2>{auditActionLabel(t, data.action)}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-3 break-all text-sm">
                <dt>{t('audit.id')}</dt>
                <dd>{data.id}</dd>
                <dt>{t('audit.action')}</dt>
                <dd className="font-mono">{data.action}</dd>
                <dt>{t('audit.statusLabel')}</dt>
                <dd>
                  <AuditStatusBadge status={data.status} />
                </dd>
                <dt>{t('audit.actor')}</dt>
                <dd>#{data.adminId}</dd>
                <dt>{t('audit.role')}</dt>
                <dd>{data.adminRole}</dd>
                <dt>{t('audit.target')}</dt>
                <dd>
                  {data.targetType ?? '—'} ·{' '}
                  {data.targetType === 'user' &&
                  data.targetId &&
                  /^\d+$/.test(data.targetId) ? (
                    <Link className="underline" to={`/users/${data.targetId}`}>
                      {data.targetLabel ?? data.targetId}
                    </Link>
                  ) : (
                    (data.targetLabel ?? '—')
                  )}{' '}
                  · {data.targetId ?? '—'}
                </dd>
                <dt>{t('audit.createdAt')}</dt>
                <dd>
                  <Timestamp value={data.createdAt} />
                </dd>
                <dt>{t('audit.updatedAt')}</dt>
                <dd>
                  <Timestamp value={data.updatedAt} />
                </dd>
                <dt>{t('audit.ip')}</dt>
                <dd>{data.ip ?? '—'}</dd>
                <dt>{t('audit.userAgent')}</dt>
                <dd>{data.userAgent ?? '—'}</dd>
                <dt>{t('audit.route')}</dt>
                <dd>{data.route ?? '—'}</dd>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="leading-[24px]">
                <h2>{t('audit.result')}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.status === 'STARTED' ? (
                <p>{t('audit.unfinished')}</p>
              ) : (
                <AuditStatusBadge status={data.status} />
              )}
              {data.errorMessage ? (
                <p className="mt-3 break-words text-sm text-destructive">
                  {data.errorMessage}
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="leading-[24px]">
                <h2>{t('audit.data')}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                {t('audit.dataHint')}
              </p>
              {Object.keys(data.meta).length === 0 ? (
                <p className="text-sm">{t('audit.noData')}</p>
              ) : (
                <>
                  <Button
                    variant="outline"
                    className="self-start"
                    onClick={() => void copy()}
                  >
                    {t('audit.copy')}
                  </Button>
                  <details open>
                    <summary className="cursor-pointer text-sm">JSON</summary>
                    <pre className="mt-2 max-h-[480px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-4 text-xs leading-[20px]">
                      {JSON.stringify(data.meta, null, 2)}
                    </pre>
                  </details>
                </>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
