import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getRateLimitMonitoring,
  saveRateLimitConfiguration,
  type RateLimitMode,
  type RateLimitPolicyConfiguration,
  type RateLimitPolicyView,
  saveFixedWindowConfiguration,
  type FixedWindowPolicy,
} from '@/api/rate-limits';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatApiError } from '@/lib/format-error';
import { toast } from 'sonner';

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
  const queryClient = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['admin', 'rate-limits'],
    queryFn: getRateLimitMonitoring,
    refetchInterval: 30_000,
  });
  const save = useMutation({
    mutationFn: saveRateLimitConfiguration,
    onSuccess: () => {
      toast.success(t('rateLimits.saved'));
      void queryClient.invalidateQueries({
        queryKey: ['admin', 'rate-limits'],
      });
    },
    onError: (error) => toast.error(formatApiError(error)),
  });
  const saveFixedWindows = useMutation({
    mutationFn: saveFixedWindowConfiguration,
    onSuccess: () => {
      toast.success(t('rateLimits.fixedWindow.saved'));
      void queryClient.invalidateQueries({
        queryKey: ['admin', 'rate-limits'],
      });
    },
    onError: (error) => toast.error(formatApiError(error)),
  });

  function savePolicy(updated: RateLimitPolicyConfiguration) {
    if (!data) return;
    save.mutate(
      data.policies.map((policy) => {
        const source = policy.policy === updated.policy ? updated : policy;
        return {
          policy: source.policy,
          mode: source.mode,
          buckets: source.buckets,
        };
      }),
    );
  }

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
          <PolicyCard
            key={policy.policy}
            policy={policy}
            saving={save.isPending}
            onSave={savePolicy}
          />
        ))}
      </div>
      {data?.fixedWindowPolicies ? (
        <FixedWindowPolicies
          policies={data.fixedWindowPolicies}
          saving={saveFixedWindows.isPending}
          onSave={(policies) => saveFixedWindows.mutate(policies)}
        />
      ) : null}
    </div>
  );
}

function FixedWindowPolicies({
  policies,
  saving,
  onSave,
}: {
  policies: FixedWindowPolicy[];
  saving: boolean;
  onSave: (policies: FixedWindowPolicy[]) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(policies);
  useEffect(() => setDraft(policies), [policies]);
  const invalid = draft.some(
    ({ limit, windowSeconds }) =>
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100_000 ||
      !Number.isInteger(windowSeconds) ||
      windowSeconds < 1 ||
      windowSeconds > 86_400,
  );
  const update = (
    index: number,
    field: 'limit' | 'windowSeconds',
    value: number,
  ) =>
    setDraft((current) =>
      current.map((policy, itemIndex) =>
        itemIndex === index ? { ...policy, [field]: value } : policy,
      ),
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('rateLimits.fixedWindow.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t('rateLimits.fixedWindow.desc')}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-h-[36rem] overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('rateLimits.fixedWindow.policy')}</TableHead>
                <TableHead>{t('rateLimits.fixedWindow.limit')}</TableHead>
                <TableHead>{t('rateLimits.fixedWindow.window')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {draft.map((policy, index) => (
                <TableRow key={policy.policy}>
                  <TableCell className="font-mono text-xs">
                    {policy.policy}
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={1}
                      max={100_000}
                      value={policy.limit}
                      onChange={(event) =>
                        update(index, 'limit', Number(event.target.value))
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={1}
                      max={86_400}
                      value={policy.windowSeconds}
                      onChange={(event) =>
                        update(
                          index,
                          'windowSeconds',
                          Number(event.target.value),
                        )
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Button
          size="sm"
          disabled={saving || invalid}
          onClick={() => onSave(draft)}
        >
          {t('rateLimits.fixedWindow.save')}
        </Button>
      </CardContent>
    </Card>
  );
}

function PolicyCard({
  policy,
  saving,
  onSave,
}: {
  policy: RateLimitPolicyView;
  saving: boolean;
  onSave: (policy: RateLimitPolicyConfiguration) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<RateLimitPolicyConfiguration>({
    policy: policy.policy,
    mode: policy.mode,
    buckets: policy.buckets,
  });
  useEffect(() => {
    setDraft({
      policy: policy.policy,
      mode: policy.mode,
      buckets: policy.buckets,
    });
  }, [policy]);
  const invalid = draft.buckets.some(
    (bucket) =>
      !Number.isFinite(bucket.ratePerSecond) ||
      bucket.ratePerSecond <= 0 ||
      !Number.isFinite(bucket.burst) ||
      bucket.burst < bucket.ratePerSecond,
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="font-mono text-base">{policy.policy}</CardTitle>
          <Select
            value={draft.mode}
            onValueChange={(mode) => {
              if (mode)
                setDraft((value) => ({
                  ...value,
                  mode: mode as RateLimitMode,
                }));
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="enforce">enforce</SelectItem>
              <SelectItem value="shadow">shadow</SelectItem>
              <SelectItem value="disabled">disabled</SelectItem>
            </SelectContent>
          </Select>
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
          <Metric label={t('rateLimits.hitRatio')} value={ratio(policy)} />
        </div>
        <Trend policy={policy} label={String(t('rateLimits.recentTrend'))} />
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
              {draft.buckets.map((bucket, bucketIndex) => (
                <TableRow key={bucket.name}>
                  <TableCell className="font-mono text-xs">
                    {bucket.name}
                    {bucket.enforce ? '' : ` (${t('rateLimits.observe')})`}
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min="0.000001"
                      step="any"
                      value={bucket.ratePerSecond}
                      onChange={(event) =>
                        setDraft((value) => ({
                          ...value,
                          buckets: value.buckets.map((item, index) =>
                            index === bucketIndex
                              ? {
                                  ...item,
                                  ratePerSecond: Number(event.target.value),
                                }
                              : item,
                          ),
                        }))
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min="0.000001"
                      step="any"
                      value={bucket.burst}
                      onChange={(event) =>
                        setDraft((value) => ({
                          ...value,
                          buckets: value.buckets.map((item, index) =>
                            index === bucketIndex
                              ? { ...item, burst: Number(event.target.value) }
                              : item,
                          ),
                        }))
                      }
                    />
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
        <Button
          size="sm"
          disabled={saving || invalid}
          onClick={() => onSave(draft)}
        >
          {t('rateLimits.save')}
        </Button>
      </CardContent>
    </Card>
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
