import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { diagnoseNetwork } from '@/api/network';
import { useMe } from '@/hooks/use-me';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Timestamp } from '@/components/common/timestamp';
import { formatApiError } from '@/lib/format-error';

export function NetworkPage() {
  const { t } = useTranslation();
  const [target, setTarget] = useState('');
  const { data: me } = useMe();
  const canProbe = me?.role === 'ADMIN' || me?.role === 'SUPER_ADMIN';
  const probe = useMutation({ mutationFn: diagnoseNetwork });
  return (
    <div className="space-y-4 text-sm leading-[20px]">
      <h1 className="text-2xl leading-[32px] font-semibold">
        {t('nav.networkInfo')}
      </h1>
      <p className="text-muted-foreground">{t('networkTools.description')}</p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (canProbe && target.trim() && !probe.isPending)
            probe.mutate(target.trim());
        }}
      >
        <Input
          aria-label={t('networkTools.target')}
          placeholder="https://example.com:443"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          disabled={probe.isPending}
        />
        <Button
          type="submit"
          disabled={!canProbe || !target.trim() || probe.isPending}
        >
          {probe.isPending ? t('common.loading') : t('networkTools.run')}
        </Button>
      </form>
      <p className="text-muted-foreground">{t('networkTools.scope')}</p>
      {probe.error && (
        <p role="alert" className="text-destructive">
          {formatApiError(probe.error)}
        </p>
      )}
      {probe.data && (
        <section className="space-y-3">
          <p className="break-all font-mono">
            {probe.data.target} · <Timestamp value={probe.data.checkedAt} /> ·{' '}
            {probe.data.durationMs} ms
          </p>
          {probe.data.checks.map((check, index) => (
            <article
              key={`${check.name}:${index}`}
              className="rounded-lg border p-4 space-y-2"
            >
              <h2 className="font-semibold">
                {t(`networkTools.${check.name}`)}{' '}
                <Badge
                  variant={check.status === 'fail' ? 'destructive' : 'outline'}
                >
                  {t(`networkTools.${check.status}`)}
                </Badge>
              </h2>
              <p>{check.detail}</p>
              {check.evidence !== undefined && (
                <details>
                  <summary className="cursor-pointer">
                    {t('networkTools.evidence')}
                  </summary>
                  <pre className="overflow-auto whitespace-pre-wrap break-all text-xs leading-[18px] mt-2">
                    {JSON.stringify(check.evidence, null, 2)}
                  </pre>
                </details>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
