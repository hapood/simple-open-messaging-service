import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { getNetworkInfo, probeNetworkIp } from '@/api/federation';
import type { IpProbeResult, IpSource } from '@/types/api';
import { Button } from '@/components/ui/button';
import { formatApiError } from '@/lib/format-error';
import { Timestamp } from '@/components/common/timestamp';

type ProbeState = { pending: boolean; result?: IpProbeResult; error?: string };

/** Local data loads on entry. Third-party requests only run after an explicit operator action. */
export function NetworkPanel() {
  const { t } = useTranslation();
  const info = useQuery({
    queryKey: ['admin', 'network-info'],
    queryFn: getNetworkInfo,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const [selected, setSelected] = useState<IpSource[]>(['ip-sb']);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [running, setRunning] = useState(false);
  const [showAllAddresses, setShowAllAddresses] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const run = async () => {
    const current = ++generation.current;
    const targets = selected.flatMap((source) =>
      ([4, 6] as const).map((family) => ({
        source,
        family,
        key: `${source}:${family}`,
      })),
    );
    setRunning(true);
    setProbes(
      Object.fromEntries(targets.map(({ key }) => [key, { pending: true }])),
    );
    void info.refetch();
    await Promise.all(
      targets.map(async ({ source, family, key }) => {
        let state: ProbeState;
        try {
          state = {
            pending: false,
            result: await probeNetworkIp(source, family),
          };
        } catch (error) {
          state = { pending: false, error: formatApiError(error) };
        }
        if (generation.current === current)
          setProbes((previous) => ({ ...previous, [key]: state }));
      }),
    );
    if (generation.current === current) setRunning(false);
  };
  const sources = info.data?.sources ?? [];
  const interfaces = info.data?.interfaces ?? [];
  const primaryAddresses = interfaces.filter(
    (item) => !['loopback', 'linkLocal'].includes(item.scope),
  );
  const visibleAddresses =
    showAllAddresses || primaryAddresses.length === 0
      ? interfaces
      : primaryAddresses;
  const hiddenCount = interfaces.length - primaryAddresses.length;
  return (
    <div className="space-y-4 text-sm leading-[20px]">
      <div className="rounded-xl border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">
              {t('federation.selfCheck.network.local')}
            </h3>
            {info.data && (
              <span className="rounded-md bg-muted px-2 py-1 text-xs leading-[16px]">
                {t(`federation.selfCheck.network.runtime.${info.data.runtime}`)}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void info.refetch()}
            disabled={info.isFetching}
          >
            {info.isFetching ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            {t('federation.selfCheck.network.refreshLocal')}
          </Button>
        </div>
        <p className="mb-3 text-xs leading-[18px] text-muted-foreground">
          {t('federation.selfCheck.network.localHint')}
        </p>
        {info.error && (
          <p role="alert" className="text-destructive">
            {formatApiError(info.error)}
          </p>
        )}
        {info.isPending && (
          <p role="status">{t('federation.selfCheck.network.loading')}</p>
        )}
        {info.data && (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              {visibleAddresses.map((item) => (
                <div
                  key={`${item.name}:${item.address}`}
                  className="min-w-0 rounded-lg border bg-muted/20 p-3"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs leading-[16px] text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {item.name}
                    </span>
                    <span>IPv{item.family}</span>
                    <span>
                      {t(`federation.selfCheck.network.scope.${item.scope}`, {
                        defaultValue: item.scope,
                      })}
                    </span>
                  </div>
                  <div className="break-all font-mono text-sm leading-[20px]">
                    {item.address}
                  </div>
                </div>
              ))}
            </div>
            {hiddenCount > 0 && primaryAddresses.length > 0 && (
              <button
                type="button"
                className="mt-3 text-xs leading-[18px] text-primary hover:underline"
                aria-expanded={showAllAddresses}
                onClick={() => setShowAllAddresses((value) => !value)}
              >
                {t(
                  showAllAddresses
                    ? 'federation.selfCheck.network.hideLocal'
                    : 'federation.selfCheck.network.showLocal',
                  { count: hiddenCount },
                )}
              </button>
            )}
            {!info.data.interfaces.length && (
              <p>{t('federation.selfCheck.network.noInterfaces')}</p>
            )}
            <p className="mt-3 text-xs leading-[16px] text-muted-foreground">
              {t('federation.selfCheck.runAt')}{' '}
              <Timestamp value={info.data.checkedAt} />
            </p>
          </>
        )}
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">
            {t('federation.selfCheck.network.external')}
          </h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void run()}
            disabled={running || !selected.length || !sources.length}
          >
            {running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t('federation.selfCheck.network.detect')}
          </Button>
        </div>
        <p className="text-xs leading-[18px] text-muted-foreground">
          {t('federation.selfCheck.network.externalHint')}
        </p>
        <fieldset className="my-3 flex flex-wrap gap-2" disabled={running}>
          <legend className="mb-2 text-xs leading-[16px] text-muted-foreground">
            {t('federation.selfCheck.network.sources')}
          </legend>
          {sources.map((source) => (
            <label
              key={source.id}
              className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs leading-[16px] has-checked:border-primary has-checked:bg-primary/5"
            >
              <input
                type="checkbox"
                checked={selected.includes(source.id)}
                onChange={(event) =>
                  setSelected((previous) =>
                    event.target.checked
                      ? [...previous, source.id]
                      : previous.filter((id) => id !== source.id),
                  )
                }
              />
              {source.label}
            </label>
          ))}
        </fieldset>
        <p className="mb-3 text-xs leading-[18px] text-muted-foreground">
          {t('federation.selfCheck.network.privacy')}
        </p>
        <div className="space-y-3" aria-live="polite">
          {sources
            .filter((source) => selected.includes(source.id))
            .map((source) => (
              <div key={source.id} className="rounded-lg border">
                <h4 className="border-b bg-muted/30 px-3 py-2 font-medium">
                  {source.label}
                </h4>
                <div className="grid divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
                  {([4, 6] as const).map((family) => {
                    const state = probes[`${source.id}:${family}`];
                    const result = state?.result;
                    const failed = !!state?.error || result?.status === 'warn';
                    return (
                      <div key={family} className="min-w-0 space-y-2 p-3">
                        <div className="flex items-center justify-between gap-2 text-xs leading-[16px]">
                          <span className="font-medium">IPv{family}</span>
                          {state?.pending ? (
                            <Loader2
                              className="size-4 animate-spin"
                              aria-label={t(
                                'federation.selfCheck.network.loading',
                              )}
                            />
                          ) : result?.status === 'ok' ? (
                            <CheckCircle2 className="size-4 text-emerald-500" />
                          ) : failed ? (
                            <AlertTriangle className="size-4 text-amber-500" />
                          ) : null}
                        </div>
                        <div className="break-all font-mono text-sm leading-[20px]">
                          {state?.pending
                            ? t('federation.selfCheck.network.loading')
                            : (result?.ip ??
                              result?.code ??
                              state?.error ??
                              t('federation.selfCheck.network.notRun'))}
                        </div>
                        {result?.code && (
                          <p className="text-xs leading-[18px] text-muted-foreground">
                            {t(
                              `federation.selfCheck.network.error.${result.code}`,
                              {
                                defaultValue: t(
                                  'federation.selfCheck.network.sourceFailure',
                                ),
                              },
                            )}
                          </p>
                        )}
                        <div className="break-all text-xs leading-[18px] text-muted-foreground">
                          {family === 4 ? source.ipv4 : source.ipv6}
                        </div>
                        {result && (
                          <div className="space-y-1 text-xs leading-[18px] text-muted-foreground">
                            <div>
                              {t('federation.selfCheck.network.sourceAddress')}:{' '}
                              <span className="break-all font-mono">
                                {result.localAddress ?? '—'}
                              </span>
                            </div>
                            <div>
                              {result.durationMs}ms ·{' '}
                              <Timestamp value={result.checkedAt} />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
