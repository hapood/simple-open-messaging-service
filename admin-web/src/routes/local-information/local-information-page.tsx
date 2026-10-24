import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { getLocalInformation } from '@/api/network';
import { Button } from '@/components/ui/button';
import { Timestamp } from '@/components/common/timestamp';
import { formatApiError } from '@/lib/format-error';

export function LocalInformationPage() {
  const { t } = useTranslation();
  const info = useQuery({
    queryKey: ['admin', 'local-information'],
    queryFn: getLocalInformation,
    refetchOnWindowFocus: false,
  });
  const data = info.data;
  const identity = data?.identity;
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('localInfo.copied'));
    } catch {
      toast.error(t('localInfo.copyFailed'));
    }
  };
  return (
    <div className="space-y-4 text-sm leading-[20px]">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl leading-[32px] font-semibold">
          {t('nav.localInformation')}
        </h1>
        <Button
          variant="outline"
          disabled={info.isFetching}
          onClick={() => void info.refetch()}
        >
          {t('localInfo.refresh')}
        </Button>
      </div>
      <p className="text-muted-foreground">{t('localInfo.description')}</p>
      {info.isPending && <p role="status">{t('common.loading')}</p>}
      {info.error && <p role="alert">{formatApiError(info.error)}</p>}
      {data && (
        <>
          <section className="rounded-lg border p-4 space-y-3">
            <h2 className="font-semibold">{t('localInfo.runtime')}</h2>
            <p>
              {t('localInfo.version')}: {data.version} · Node {data.nodeVersion}{' '}
              · {data.runtime}
            </p>
            <p>
              {t('localInfo.startedAt')}: <Timestamp value={data.startedAt} />
            </p>
            <p>
              {t('localInfo.uptime')}: {data.uptimeSeconds} s
            </p>
            <p>
              {t('localInfo.serverTime')}: <Timestamp value={data.checkedAt} />
            </p>
          </section>
          <section className="rounded-lg border p-4 space-y-3">
            <h2 className="font-semibold">{t('localInfo.identity')}</h2>
            {!identity ? (
              <p role="alert">{t('localInfo.identityUnavailable')}</p>
            ) : (
              <>
                <p className="break-all">
                  {identity.domain} · namespace {identity.namespaceId} · SOMFP{' '}
                  {identity.protocolVersions.join(', ')} · {identity.algorithm}
                </p>
                <p>
                  {t('localInfo.keyCreated')}:{' '}
                  <Timestamp value={identity.createdAt} />
                </p>
                {(
                  [
                    ['keyId', identity.keyId],
                    ['publicKey', identity.publicKey],
                    ['rootPublicKey', identity.rootPublicKey],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span>{t(`localInfo.${label}`)}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void copy(value)}
                      >
                        {t('localInfo.copy')}
                      </Button>
                    </div>
                    <p className="font-mono break-all rounded bg-muted p-2">
                      {value}
                    </p>
                  </div>
                ))}
                <details>
                  <summary className="cursor-pointer">
                    {t('localInfo.roots')}
                  </summary>
                  {identity.roots.map((root) => (
                    <div
                      key={root.id}
                      className="border rounded p-3 mt-2 space-y-1"
                    >
                      <p>
                        #{root.id} ·{' '}
                        {t(
                          root.unpublishedAt !== null
                            ? 'localInfo.unpublished'
                            : root.claimable
                              ? 'localInfo.current'
                              : 'localInfo.predecessor',
                        )}
                      </p>
                      <p className="font-mono break-all">
                        {root.rootPublicKey}
                      </p>
                      <p>
                        <Timestamp value={root.notBefore} /> —{' '}
                        <Timestamp value={root.notAfter} />
                      </p>
                    </div>
                  ))}
                </details>
                <details>
                  <summary className="cursor-pointer">
                    {t('localInfo.certificates')}
                  </summary>
                  <pre className="whitespace-pre-wrap break-all text-xs leading-[18px] mt-2">
                    {JSON.stringify(identity.certificates, null, 2)}
                  </pre>
                </details>
              </>
            )}
          </section>
          <section className="rounded-lg border p-4 space-y-3">
            <h2 className="font-semibold">{t('localInfo.configuration')}</h2>
            <p className="text-muted-foreground">{t('localInfo.configHint')}</p>
            <p>
              {t('localInfo.origin')}: {data.configuration.origin ?? '—'} ·{' '}
              {data.configuration.tlsMode}
            </p>
            <p>
              {t('localInfo.lanDomain')}: {data.configuration.lanDomain ?? '—'}
            </p>
            <p>
              {t('localInfo.insecureHttp')}:{' '}
              {String(data.configuration.insecureHttp)}
            </p>
          </section>
          <section className="rounded-lg border p-4 space-y-3">
            <h2 className="font-semibold">{t('localInfo.interfaces')}</h2>
            <p className="text-muted-foreground">
              {t('localInfo.interfaceHint')}
            </p>
            {data.interfaces.map((item) => (
              <p
                key={`${item.name}:${item.address}`}
                className="font-mono break-all"
              >
                {item.name} · IPv{item.family} · {item.address} · {item.scope}
              </p>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
