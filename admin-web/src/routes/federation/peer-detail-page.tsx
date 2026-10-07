import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import {
  useFederationPeer,
  useFederationPeerNamespaces,
  useApproveFederationIdentityReview,
  useRejectFederationIdentityReview,
  useFederationPredecessorCheck,
  useBlockFederationPeer,
  useUnblockFederationPeer,
  useRecognizeFederationPeer,
} from '@/hooks/use-federation';
import { useIsSuperAdmin } from '@/hooks/use-me';
import { useQuotaNodes } from '@/hooks/use-quotas';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Timestamp } from '@/components/common/timestamp';
import { formatApiError } from '@/lib/format-error';
import { PeerStatusBadge } from './peer-status-badge';
import { PeerQuotaPanel } from './peer-quota-panel';

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

function FeedProgressCard({
  title,
  pulled,
  end,
  endLabel,
  showLag = false,
}: {
  title: string;
  pulled: string | null;
  end: string;
  endLabel: string;
  showLag?: boolean;
}) {
  const { t } = useTranslation();
  const status = showLag ? feedProgressStatus(pulled, end) : null;
  const text =
    status === null
      ? null
      : status.key === 'federation.feed.behind'
        ? t(status.key, { count: status.lag.toString() })
        : t(status.key);
  const variant = status !== null && status.lag > 0n ? 'outline' : 'secondary';
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-medium">{title}</span>
        {text ? <Badge variant={variant}>{text}</Badge> : null}
      </div>
      <div className="grid grid-cols-2 gap-3 font-mono text-xs text-muted-foreground">
        <div>
          <div>{t('federation.feed.pulled')}</div>
          <div>{pulled ?? '-'}</div>
        </div>
        <div>
          <div>{endLabel}</div>
          <div>{end}</div>
        </div>
      </div>
    </div>
  );
}

type FeedProgressStatusKey =
  | 'federation.feed.notStarted'
  | 'federation.feed.caughtUp'
  | 'federation.feed.behind';

function feedProgressStatus(
  pulled: string | null,
  end: string,
): { key: FeedProgressStatusKey; lag: bigint } {
  if (pulled === null)
    return { key: 'federation.feed.notStarted', lag: 1n };
  const lag = nonNegativeDiff(end, pulled);
  return {
    key: lag === 0n ? 'federation.feed.caughtUp' : 'federation.feed.behind',
    lag,
  };
}

function nonNegativeDiff(end: string, pulled: string): bigint {
  const diff = BigInt(end) - BigInt(pulled);
  return diff > 0n ? diff : 0n;
}

/** Routed peer detail (deep-linkable by domain). Replaces the old PeerDetailDialog so a peer view is
 *  shareable/bookmarkable and respects browser back. */
export function PeerDetailPage() {
  const { t } = useTranslation();
  const { domain = '' } = useParams<{ domain: string }>();
  const d = decodeURIComponent(domain);
  const { data: peer, isLoading, error } = useFederationPeer(d);
  const { data: namespaceData, isLoading: namespacesLoading } =
    useFederationPeerNamespaces(d);
  const namespaces = namespaceData?.namespaces;
  const reviews = namespaceData?.reviews;
  const block = useBlockFederationPeer();
  const unblock = useUnblockFederationPeer();
  const recognize = useRecognizeFederationPeer();
  const approveReview = useApproveFederationIdentityReview();
  const rejectReview = useRejectFederationIdentityReview();
  const predecessorCheck = useFederationPredecessorCheck();
  const [predecessorResult, setPredecessorResult] = useState<
    string | undefined
  >(undefined);
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

  const onRecognize = async () => {
    if (!window.confirm(t('federation.action.confirmRecognize'))) return;
    try {
      const result = await recognize.mutateAsync(d);
      toast.success(
        result.status === 'recognized'
          ? t('federation.toast.recognized')
          : t('federation.toast.recognitionPending'),
      );
    } catch (e) {
      toast.error(formatApiError(e));
    }
  };

  const onDecideReview = async (
    reviewId: number,
    kind: 'domain-rebind' | 'root-rotation',
    decision: 'approved' | 'rejected',
  ) => {
    if (
      !window.confirm(
        decision === 'approved'
          ? t('federation.reviews.confirmApprove', {
              kind: t(`federation.reviews.kind.${kind}`),
            })
          : t('federation.reviews.confirmReject', {
              kind: t(`federation.reviews.kind.${kind}`),
            }),
      )
    ) {
      return;
    }
    try {
      if (decision === 'approved') {
        await approveReview.mutateAsync(reviewId);
        toast.success(t('federation.toast.reviewApproved'));
      } else {
        await rejectReview.mutateAsync(reviewId);
        toast.success(t('federation.toast.reviewRejected'));
      }
    } catch (e) {
      toast.error(formatApiError(e));
    }
  };

  const onPredecessorCheck = async (reviewId: number) => {
    try {
      const result = await predecessorCheck.mutateAsync(reviewId);
      setPredecessorResult(`${result.ok ? '✓' : '✗'} ${result.detail}`);
      if (result.ok) toast.success(t('federation.reviews.predecessorOk'));
      else toast.warning(t('federation.reviews.predecessorFailed'));
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
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={onRecognize}
                  disabled={recognize.isPending}
                >
                  {t('federation.action.recognize')}
                </Button>
                <Button
                  variant={blocked ? 'default' : 'destructive'}
                  onClick={onToggleBlock}
                  disabled={block.isPending || unblock.isPending}
                >
                  {blocked
                    ? t('federation.action.unblock')
                    : t('federation.action.block')}
                </Button>
              </div>
            ) : null}
          </div>

          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">
                {t('federation.detail.tabOverview')}
              </TabsTrigger>
              <TabsTrigger value="namespaces">
                {t('federation.detail.tabNamespaces')}
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
                  <Meta label={t('federation.meta.activeNamespace')}>
                    {peer.id ?? t('federation.meta.none')}
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

              <Card className="mt-4">
                <CardHeader>
                  <CardTitle>{t('federation.feed.title')}</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 text-sm md:grid-cols-2">
                  <FeedProgressCard
                    title={t('federation.feed.state')}
                    pulled={peer.feedProgress.inboundStateFeedPulledThrough}
                    end={peer.feedProgress.outboundStateFeedEndId}
                    endLabel={t('federation.feed.localOutboundEnd')}
                  />
                  <FeedProgressCard
                    title={t('federation.feed.profileNamespace')}
                    pulled={
                      peer.feedProgress.inboundProfileNamespaceFeedPulledThrough
                    }
                    end={peer.feedProgress.remoteProfileNamespaceFeedEndId}
                    endLabel={t('federation.feed.observedEnd')}
                    showLag
                  />
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="namespaces">
              <Card>
                <CardHeader>
                  <CardTitle>{t('federation.namespaces.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {namespacesLoading ? (
                    <div className="py-4 text-sm text-muted-foreground">
                      {t('common.loading')}
                    </div>
                  ) : (namespaces?.length ?? 0) === 0 ? (
                    <div className="py-6 text-center text-sm text-muted-foreground">
                      {t('federation.namespaces.empty')}
                    </div>
                  ) : (
                    <div className="rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-24">
                              {t('federation.namespaces.col.id')}
                            </TableHead>
                            <TableHead>
                              {t('federation.namespaces.col.rootKey')}
                            </TableHead>
                            <TableHead className="w-32">
                              {t('federation.namespaces.col.peerAssigned')}
                            </TableHead>
                            <TableHead className="w-40">
                              {t('federation.namespaces.col.pinnedAt')}
                            </TableHead>
                            <TableHead className="w-40">
                              {t('federation.namespaces.col.retiredAt')}
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {namespaces?.map((ns) => (
                            <TableRow key={ns.id}>
                              <TableCell className="font-mono text-sm">
                                {ns.id}{' '}
                                {ns.active ? (
                                  <Badge variant="secondary">
                                    {t('federation.namespaces.active')}
                                  </Badge>
                                ) : null}
                                {ns.retiredAt ? (
                                  <Badge variant="outline">
                                    {t('federation.namespaces.retired')}
                                  </Badge>
                                ) : null}
                              </TableCell>
                              <TableCell className="max-w-80 break-all font-mono text-xs text-muted-foreground">
                                {ns.rootPublicKey ?? t('federation.meta.none')}
                              </TableCell>
                              <TableCell className="font-mono text-sm">
                                {ns.peerAssignedLocalNamespaceId ??
                                  t('federation.meta.none')}
                              </TableCell>
                              <TableCell>
                                <Timestamp value={ns.identityPinnedAt} />
                              </TableCell>
                              <TableCell>
                                <Timestamp value={ns.retiredAt} />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
              {(reviews?.length ?? 0) > 0 ? (
                <Card className="mt-4">
                  <CardHeader>
                    <CardTitle>{t('federation.reviews.title')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-32">
                              {t('federation.reviews.col.kind')}
                            </TableHead>
                            <TableHead className="w-36">
                              {t('federation.reviews.col.status')}
                            </TableHead>
                            <TableHead>
                              {t('federation.reviews.col.roots')}
                            </TableHead>
                            <TableHead className="w-40">
                              {t('federation.reviews.col.arrivedAt')}
                            </TableHead>
                            <TableHead className="w-64" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {reviews?.map((review) => (
                            <TableRow key={review.id}>
                              <TableCell>
                                <Badge variant="outline">
                                  {t(`federation.reviews.kind.${review.kind}`)}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-sm">
                                {t(
                                  `federation.reviews.status.${review.status}`,
                                )}
                              </TableCell>
                              <TableCell className="max-w-96 break-all font-mono text-xs text-muted-foreground">
                                {review.kind === 'root-rotation'
                                  ? `${String(review.claim.previousRoot ?? '—')} → ${review.claimedRoot}`
                                  : `${review.claimedRoot} @ ${review.nextDomain}`}
                              </TableCell>
                              <TableCell>
                                <Timestamp value={review.createdAt} />
                              </TableCell>
                              <TableCell className="text-right">
                                {review.status === 'pending' && isSuper ? (
                                  <div className="flex justify-end gap-2">
                                    {review.kind === 'root-rotation' ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                          onPredecessorCheck(review.id)
                                        }
                                        disabled={predecessorCheck.isPending}
                                      >
                                        {t(
                                          'federation.reviews.predecessorCheck',
                                        )}
                                      </Button>
                                    ) : null}
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        onDecideReview(
                                          review.id,
                                          review.kind,
                                          'rejected',
                                        )
                                      }
                                      disabled={rejectReview.isPending}
                                    >
                                      {t('federation.reviews.reject')}
                                    </Button>
                                    <Button
                                      size="sm"
                                      onClick={() =>
                                        onDecideReview(
                                          review.id,
                                          review.kind,
                                          'approved',
                                        )
                                      }
                                      disabled={approveReview.isPending}
                                    >
                                      {t('federation.reviews.approve')}
                                    </Button>
                                  </div>
                                ) : null}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {predecessorResult ? (
                      <div className="mt-3 break-all font-mono text-xs text-muted-foreground">
                        {predecessorResult}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              ) : null}
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
