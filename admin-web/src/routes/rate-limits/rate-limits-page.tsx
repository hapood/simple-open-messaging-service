import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getRateLimitMonitoring,
  type RateLimitPolicyView,
} from '@/api/rate-limits';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatApiError } from '@/lib/format-error';

const MODE_VARIANT = {
  disabled: 'destructive',
  shadow: 'secondary',
  enforce: 'default',
} as const;

const ADVICE_KEYS = {
  disabled: 'rateLimits.advice.disabled',
  'insufficient-sample': 'rateLimits.advice.insufficient-sample',
  stale: 'rateLimits.advice.stale',
  'high-would-block': 'rateLimits.advice.high-would-block',
  'high-block-rate': 'rateLimits.advice.high-block-rate',
  'long-retry': 'rateLimits.advice.long-retry',
  'review-ready': 'rateLimits.advice.review-ready',
} as const;

function ratio(policy: RateLimitPolicyView): string {
  const hits =
    policy.mode === 'shadow' ? policy.totals.wouldBlock : policy.totals.blocked;
  return policy.totals.evaluated
    ? `${((hits / policy.totals.evaluated) * 100).toFixed(2)}%`
    : '—';
}

function AdviceIcon({ level }: { level: 'info' | 'warning' | 'critical' }) {
  if (level === 'critical')
    return <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />;
  if (level === 'warning')
    return <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />;
  return <Info className="mt-0.5 size-4 shrink-0 text-blue-500" />;
}

export function RateLimitsPage() {
  const { t } = useTranslation();
  const { data, error, isLoading } = useQuery({
    queryKey: ['admin', 'rate-limits'],
    queryFn: getRateLimitMonitoring,
    refetchInterval: 30_000,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('rateLimits.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('rateLimits.desc')}
        </p>
      </div>
      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {t('common.loadFailed', { message: formatApiError(error) })}
        </div>
      ) : null}
      {isLoading ? (
        <div className="text-sm text-muted-foreground">
          {t('common.loading')}
        </div>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {data?.policies.map((policy) => (
          <Card key={policy.policy}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="font-mono text-base">
                  {policy.policy}
                </CardTitle>
                <Badge variant={MODE_VARIANT[policy.mode]}>{policy.mode}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-4 gap-2 text-center">
                <Metric
                  label={t('rateLimits.evaluated')}
                  value={policy.totals.evaluated}
                />
                <Metric
                  label={t('rateLimits.wouldBlock')}
                  value={policy.totals.wouldBlock}
                />
                <Metric
                  label={t('rateLimits.blocked')}
                  value={policy.totals.blocked}
                />
                <Metric
                  label={t('rateLimits.hitRatio')}
                  value={ratio(policy)}
                />
              </div>
              <Trend policy={policy} label={t('rateLimits.recentTrend')} />
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('rateLimits.dimension')}</TableHead>
                      <TableHead>{t('rateLimits.rate')}</TableHead>
                      <TableHead>{t('rateLimits.burst')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {policy.buckets.map((bucket) => (
                      <TableRow key={bucket.name}>
                        <TableCell className="font-mono text-xs">
                          {bucket.name}
                          {bucket.enforce ? '' : ' (observe)'}
                        </TableCell>
                        <TableCell>
                          <div>{bucket.ratePerSecond}/s</div>
                          <div className="font-mono text-[9px] text-muted-foreground">
                            {bucket.rateEnv}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div>{bucket.burst}</div>
                          <div className="font-mono text-[9px] text-muted-foreground">
                            {bucket.burstEnv}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="space-y-2">
                {policy.advice.map((item) => (
                  <div
                    key={item.code}
                    className="flex gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs"
                  >
                    <AdviceIcon level={item.level} />
                    <span>
                      {ADVICE_KEYS[item.code as keyof typeof ADVICE_KEYS]
                        ? t(ADVICE_KEYS[item.code as keyof typeof ADVICE_KEYS])
                        : item.message}
                    </span>
                  </div>
                ))}
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {policy.modeEnv}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md bg-muted/50 p-2">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function Trend({
  policy,
  label,
}: {
  policy: RateLimitPolicyView;
  label: string;
}) {
  const samples = policy.samples.slice(-12);
  const values = samples.map((sample) =>
    policy.mode === 'shadow' ? sample.wouldBlock : sample.blocked,
  );
  const max = Math.max(1, ...values);
  return (
    <div>
      <div className="mb-1 text-[11px] text-muted-foreground">{label}</div>
      <div className="flex h-8 items-end gap-1 rounded bg-muted/40 px-2 py-1">
        {values.length ? (
          values.map((value, index) => (
            <div
              key={`${samples[index].endedAt}-${index}`}
              title={`${value} / ${samples[index].evaluated}`}
              className="min-w-1 flex-1 rounded-sm bg-primary/70"
              style={{ height: `${Math.max(8, (value / max) * 100)}%` }}
            />
          ))
        ) : (
          <span className="text-[11px] text-muted-foreground">—</span>
        )}
      </div>
    </div>
  );
}
