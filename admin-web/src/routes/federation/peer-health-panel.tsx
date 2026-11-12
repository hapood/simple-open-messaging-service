import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FederationPeerState } from '@/types/api';
import { useIsAdminPlus } from '@/hooks/use-me';
import { useProbeFederationHealth } from '@/hooks/use-federation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatApiError } from '@/lib/format-error';
import { PeerMeta, PeerTime } from './peer-detail-primitives';

export function PeerHealthFlags({ peer }: { peer: FederationPeerState }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {(
        [
          'localServiceAvailable',
          'peerAcceptanceConfirmed',
          'remoteServiceReachable',
        ] as const
      ).map((field) => (
        <PeerMeta key={field} label={t(`federation.inspect.${field}`)}>
          <Badge variant={peer[field] ? 'secondary' : 'outline'}>
            {t(
              peer[field] ? 'federation.inspect.yes' : 'federation.inspect.no',
            )}
          </Badge>
        </PeerMeta>
      ))}
    </div>
  );
}

/** Manual and scheduled checks share the persisted, namespace-bound observation. */
export function PeerHealthPanel({ peer }: { peer: FederationPeerState }) {
  const { t } = useTranslation();
  const canProbe = useIsAdminPlus();
  const probe = useProbeFederationHealth();
  const observation = peer.feedProgress.latestHealthCheck;
  const [requestError, setRequestError] = useState<string | null>(null);
  const run = async () => {
    setRequestError(null);
    try {
      await probe.mutateAsync(peer.id);
    } catch (error) {
      setRequestError(formatApiError(error));
    }
  };
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('federation.inspect.localHealth')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <PeerHealthFlags peer={peer} />
          <div className="grid gap-4 sm:grid-cols-3">
            <PeerMeta label={t('federation.meta.lastSuccessAt')}>
              <PeerTime value={peer.lastSuccessAt} />
            </PeerMeta>
            <PeerMeta label={t('federation.meta.degradedAt')}>
              <PeerTime value={peer.degradedAt} />
            </PeerMeta>
            <PeerMeta label={t('federation.meta.degradationCount')}>
              {peer.degradationCount}
            </PeerMeta>
          </div>
          {peer.degradationReason ? (
            <p className="break-all text-sm leading-[20px] text-destructive">
              {peer.degradationReason}
            </p>
          ) : null}
          <p className="text-xs leading-[20px] text-muted-foreground">
            {t('federation.inspect.healthHint')}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t('federation.inspect.manualHealth')}</CardTitle>
          {canProbe ? (
            <Button
              onClick={run}
              disabled={
                probe.isPending || !peer.active || peer.trustLevel === 'halted'
              }
              variant="outline"
            >
              {t(
                probe.isPending
                  ? 'federation.inspect.probing'
                  : 'federation.inspect.probe',
              )}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-[20px] text-muted-foreground">
            {t('federation.inspect.probeHint')}
          </p>
          {requestError ? (
            <p
              role="alert"
              className="break-all text-sm leading-[20px] text-destructive"
            >
              {requestError}
            </p>
          ) : null}
          {observation ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <PeerMeta label={t('federation.inspect.probeStartedAt')}>
                <PeerTime value={observation.startedAt} />
              </PeerMeta>
              <PeerMeta label={t('federation.inspect.probeCompletedAt')}>
                <PeerTime value={observation.completedAt} />
              </PeerMeta>
              <PeerMeta label={t('federation.inspect.duration')}>
                {observation.durationMs} ms
              </PeerMeta>
              <PeerMeta label={t('federation.inspect.source')}>
                {t(`federation.inspect.sourceKind.${observation.source}`)}
              </PeerMeta>
              {observation.status !== null ? (
                <PeerMeta label={t('federation.inspect.remoteHealth')}>
                  <Badge variant="outline">
                    {t(`federation.inspect.healthResult.${observation.status}`)}
                  </Badge>
                </PeerMeta>
              ) : null}
              {observation.error ? (
                <p className="break-all text-sm leading-[20px] text-destructive">
                  {observation.error}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm leading-[20px] text-muted-foreground">
              {t(
                probe.isPending
                  ? 'federation.inspect.probing'
                  : 'federation.inspect.notProbed',
              )}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
