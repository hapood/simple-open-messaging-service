import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import {
  useFederationPeer,
  useFederationPeerEvents,
  useBlockFederationPeer,
  useUnblockFederationPeer,
} from '@/hooks/use-federation';
import { useIsSuperAdmin } from '@/hooks/use-me';
import { useQuotaNodes } from '@/hooks/use-quotas';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Timestamp } from '@/components/common/timestamp';
import { formatApiError } from '@/lib/format-error';
import { PeerStatusBadge } from './peer-status-badge';
import { PeerTimeline } from './peer-timeline';
import { PeerQuotaPanel } from './peer-quota-panel';

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

/** Routed peer detail (deep-linkable by domain). Replaces the old PeerDetailDialog so a peer view is
 *  shareable/bookmarkable and respects browser back. Overview = lifecycle metadata + Block/Unblock;
 *  Timeline = the trust-lifecycle event feed. */
export function PeerDetailPage() {
  const { t } = useTranslation();
  const { domain = '' } = useParams<{ domain: string }>();
  const d = decodeURIComponent(domain);
  const { data: peer, isLoading, error } = useFederationPeer(d);
  const { data: events, isLoading: eventsLoading } = useFederationPeerEvents(d);
  const block = useBlockFederationPeer();
  const unblock = useUnblockFederationPeer();
  const isSuper = useIsSuperAdmin();
  const { data: quotaNodes, isLoading: quotaLoading } = useQuotaNodes();
  const quotaNode = quotaNodes?.find((node) => node.domain === d);

  const blocked = peer?.trustLevel === 'halted' && peer.haltCode === 50009;
  const onToggleBlock = async () => {
    try {
      if (blocked) {
        await unblock.mutateAsync(d);
        toast.success(t('federation.toast.unblocked'));
      } else {
        await block.mutateAsync({ domain: d });
        toast.success(t('federation.toast.blocked'));
      }
    } catch (e) {
      toast.error(formatApiError(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/federation"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t('federation.detail.back')}
      </Link>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {t('common.loadFailed', { message: formatApiError(error) })}
        </div>
      ) : !peer ? (
        <div className="rounded-md border px-4 py-8 text-center text-sm text-muted-foreground">
          {t('federation.detail.notFound')}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h1 className="font-mono text-2xl font-semibold tracking-tight">
                {peer.domain}
              </h1>
              <PeerStatusBadge level={peer.trustLevel} />
            </div>
            {isSuper ? (
              <Button
                variant={blocked ? 'default' : 'destructive'}
                onClick={onToggleBlock}
                disabled={block.isPending || unblock.isPending}
              >
                {blocked
                  ? t('federation.action.unblock')
                  : t('federation.action.block')}
              </Button>
            ) : null}
          </div>

          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">
                {t('federation.detail.tabOverview')}
              </TabsTrigger>
              <TabsTrigger value="timeline">
                {t('federation.detail.tabTimeline')}
              </TabsTrigger>
              <TabsTrigger value="quota">
                {t('federation.detail.tabQuota')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <Card>
                <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-3">
                  <Meta label={t('federation.meta.createdAt')}>
                    <Timestamp value={peer.createdAt} />
                  </Meta>
                  <Meta label={t('federation.meta.trustedAt')}>
                    <Timestamp value={peer.trustedAt} />
                  </Meta>
                  <Meta label={t('federation.meta.lastSuccessAt')}>
                    <Timestamp value={peer.lastSuccessAt} />
                  </Meta>
                  <Meta label={t('federation.meta.degradedAt')}>
                    <Timestamp value={peer.degradedAt} />
                  </Meta>
                  <Meta label={t('federation.meta.degradationCount')}>
                    {peer.degradationCount}
                  </Meta>
                  <Meta label={t('federation.meta.addedBy')}>
                    {peer.addedBy ?? t('federation.meta.auto')}
                  </Meta>
                  {peer.degradationReason ? (
                    <div className="col-span-2 md:col-span-3">
                      <Meta label={t('federation.meta.lastError')}>
                        <span className="break-all text-destructive">
                          {peer.degradationReason}
                        </span>
                      </Meta>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="timeline">
              <Card>
                <CardHeader>
                  <CardTitle>{t('federation.timeline.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {eventsLoading ? (
                    <div className="py-4 text-sm text-muted-foreground">
                      {t('common.loading')}
                    </div>
                  ) : (
                    <PeerTimeline events={events ?? []} />
                  )}
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="quota">
              {quotaLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : quotaNode ? (
                <PeerQuotaPanel node={quotaNode} />
              ) : (
                <div className="rounded-md border px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('quota.unavailable')}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
