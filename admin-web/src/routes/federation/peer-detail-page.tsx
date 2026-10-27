import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import {
  useFederationPeer,
  useFederationPeerNamespaces,
  useApproveFederationIdentityReview,
  useRejectFederationIdentityReview,
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
import {
  PeerMeta as Meta,
  PeerCoordinate,
  PeerTime,
} from './peer-detail-primitives';
import { PeerFeedPanel } from './peer-feed-panel';
import { PeerHealthFlags, PeerHealthPanel } from './peer-health-panel';

/** Routed peer detail (deep-linkable by domain). Replaces the old PeerDetailDialog so a peer view is
 *  shareable/bookmarkable and respects browser back. */
export function PeerDetailPage() {
  const { t } = useTranslation();
  const { domain = '' } = useParams<{ domain: string }>();
  const d = domain;
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab') ?? 'overview';
  const tab = ['overview', 'namespaces', 'health', 'feed', 'quota'].includes(
    requestedTab,
  )
    ? requestedTab
    : 'overview';
  const selectTab = (value: string) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === 'overview') next.delete('tab');
      else next.set('tab', value);
      return next;
    });
  const {
    data: peer,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useFederationPeer(d);
  const {
    data: namespaceData,
    isLoading: namespacesLoading,
    error: namespacesError,
    refetch: refetchNamespaces,
  } = useFederationPeerNamespaces(d);
  const namespaces = namespaceData?.namespaces;
  const reviews = namespaceData?.reviews;
  const block = useBlockFederationPeer();
  const unblock = useUnblockFederationPeer();
  const recognize = useRecognizeFederationPeer();
  const approveReview = useApproveFederationIdentityReview();
  const rejectReview = useRejectFederationIdentityReview();
  const isSuper = useIsSuperAdmin();
  const {
    data: quotaNodes,
    isLoading: quotaLoading,
    error: quotaError,
  } = useQuotaNodes();
  const quotaNode = quotaNodes?.find((node) => node.namespaceId === peer?.id);

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
    kind: 'domain-rebind' | 'root-rotation' | 'identity-reset',
    decision: 'approved' | 'rejected',
    resolution?: 'new-peer' | 'replace-identity',
  ) => {
    if (
      !window.confirm(
        decision === 'approved'
          ? t(
              resolution
                ? `federation.reviews.confirm.${resolution}`
                : 'federation.reviews.confirmApprove',
              {
                kind: t(`federation.reviews.kind.${kind}`),
              },
            )
          : t('federation.reviews.confirmReject', {
              kind: t(`federation.reviews.kind.${kind}`),
            }),
      )
    ) {
      return;
    }
    try {
      if (decision === 'approved') {
        await approveReview.mutateAsync(
          resolution ? { reviewId, resolution } : reviewId,
        );
        toast.success(t('federation.toast.reviewApproved'));
      } else {
        await rejectReview.mutateAsync(reviewId);
        toast.success(t('federation.toast.reviewRejected'));
      }
    } catch (e) {
      toast.error(formatApiError(e));
    }
  };

  return (
    <div className="flex flex-col gap-4 leading-[20px] [&_th]:leading-[20px] [&_td]:leading-[20px]">
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

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-muted-foreground">
            <Meta label={t('federation.meta.activeNamespace')}>
              <PeerCoordinate value={peer.id} />
            </Meta>
            <Meta label={t('federation.namespaces.col.peerAssigned')}>
              <PeerCoordinate value={peer.peerAssignedLocalNamespaceId} />
            </Meta>
            <Button
              variant="outline"
              disabled={isFetching}
              onClick={() => {
                void refetch();
                void refetchNamespaces();
              }}
            >
              {t('federation.inspect.refresh')}
            </Button>
          </div>
          {peer.trustLevel === 'halted' ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 p-4 text-sm leading-[20px] text-destructive"
            >
              <p>
                {peer.haltReason ?? t('federation.status.halted')}{' '}
                {peer.haltCode == null ? null : `(${peer.haltCode})`}
              </p>
              <PeerTime value={peer.haltedAt} />
            </div>
          ) : null}
          {reviews?.some((review) => review.status === 'pending') ? (
            <Button
              variant="outline"
              className="self-start"
              onClick={() => selectTab('namespaces')}
            >
              {t('federation.inspect.pendingReviews', {
                count: reviews.filter((review) => review.status === 'pending')
                  .length,
              })}
            </Button>
          ) : null}

          <Tabs value={tab} onValueChange={(value) => selectTab(String(value))}>
            <div className="overflow-x-auto">
              <TabsList className="h-10">
                <TabsTrigger value="overview">
                  {t('federation.detail.tabOverview')}
                </TabsTrigger>
                <TabsTrigger value="namespaces">
                  {t('federation.detail.tabNamespaces')}
                </TabsTrigger>
                <TabsTrigger value="health">
                  {t('federation.detail.tabHealth')}
                </TabsTrigger>
                <TabsTrigger value="feed">
                  {t('federation.detail.tabFeed')}
                </TabsTrigger>
                <TabsTrigger value="quota">
                  {t('federation.detail.tabQuota')}
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="overview">
              <Card className="mb-4">
                <CardHeader>
                  <CardTitle>{t('federation.inspect.localHealth')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <PeerHealthFlags peer={peer} />
                </CardContent>
              </Card>
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
                <CardContent className="grid gap-4 sm:grid-cols-3">
                  <Meta label={t('federation.feed.state')}>
                    <PeerCoordinate
                      value={peer.feedProgress.inboundStateFeedPulledThrough}
                    />
                  </Meta>
                  <Meta label={t('federation.feed.profileNamespace')}>
                    <PeerCoordinate
                      value={
                        peer.feedProgress
                          .inboundProfileNamespaceFeedPulledThrough
                      }
                    />
                  </Meta>
                  <Meta label={t('federation.receipt.receivedAt')}>
                    <PeerTime value={peer.latestFeedHeadReceipt?.receivedAt} />
                  </Meta>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="feed">
              <PeerFeedPanel peer={peer} />
            </TabsContent>
            <TabsContent value="health">
              <PeerHealthPanel
                key={`${d}:${peer.id}:${peer.rootPublicKey}`}
                peer={peer}
              />
            </TabsContent>
            <TabsContent value="namespaces">
              <Card className="mb-4">
                <CardHeader>
                  <CardTitle>{t('federation.inspect.identity')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 lg:grid-cols-3">
                    <Meta label={t('federation.inspect.lastHandshakeAt')}>
                      <PeerTime value={peer.feedProgress.lastHandshakeAt} />
                    </Meta>
                    <Meta label={t('federation.inspect.signingKeyCreatedAt')}>
                      <PeerTime value={peer.signingKeyCreatedAt} />
                    </Meta>
                    <Meta label={t('federation.namespaces.col.pinnedAt')}>
                      <PeerTime value={peer.identityPinnedAt} />
                    </Meta>
                    <Meta label={t('federation.meta.trustedAt')}>
                      <PeerTime value={peer.trustedAt} />
                    </Meta>
                  </div>
                  <Meta label={t('federation.namespaces.col.rootKey')}>
                    <details>
                      <summary className="cursor-pointer font-mono text-xs leading-[20px]">
                        {peer.rootPublicKey
                          ? `${peer.rootPublicKey.slice(0, 16)}…`
                          : '—'}
                      </summary>
                      <PeerCoordinate value={peer.rootPublicKey} />
                    </details>
                  </Meta>
                  <PeerHealthFlags peer={peer} />
                  <p className="text-xs leading-[20px] text-muted-foreground">
                    {t('federation.inspect.identityHint')}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t('federation.namespaces.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {namespacesLoading ? (
                    <div className="py-4 text-sm text-muted-foreground">
                      {t('common.loading')}
                    </div>
                  ) : namespacesError ? (
                    <p role="alert" className="text-destructive">
                      {formatApiError(namespacesError)}
                    </p>
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
                                {review.kind !== 'domain-rebind'
                                  ? `${String(review.claim.previousRoot ?? '—')} → ${review.claimedRoot}`
                                  : `${review.claimedRoot} @ ${review.nextDomain}`}
                              </TableCell>
                              <TableCell>
                                <Timestamp value={review.createdAt} />
                              </TableCell>
                              <TableCell className="text-right">
                                {review.status === 'pending' && isSuper ? (
                                  <div className="flex justify-end gap-2">
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
                                    {review.kind === 'identity-reset' ? (
                                      <>
                                        {(
                                          [
                                            'new-peer',
                                            'replace-identity',
                                          ] as const
                                        ).map((resolution) => (
                                          <Button
                                            key={resolution}
                                            size="sm"
                                            disabled={
                                              approveReview.isPending ||
                                              !review.epochMatched
                                            }
                                            onClick={() =>
                                              onDecideReview(
                                                review.id,
                                                review.kind,
                                                'approved',
                                                resolution,
                                              )
                                            }
                                          >
                                            {t(
                                              `federation.reviews.${resolution}`,
                                            )}
                                          </Button>
                                        ))}
                                      </>
                                    ) : (
                                      <Button
                                        size="sm"
                                        onClick={() =>
                                          onDecideReview(
                                            review.id,
                                            review.kind,
                                            'approved',
                                          )
                                        }
                                        disabled={
                                          approveReview.isPending ||
                                          !review.epochMatched
                                        }
                                        title={
                                          review.epochMatched
                                            ? undefined
                                            : t(
                                                'federation.reviews.epochDrifted',
                                              )
                                        }
                                      >
                                        {t('federation.reviews.approve')}
                                      </Button>
                                    )}
                                  </div>
                                ) : null}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              ) : null}
            </TabsContent>
            <TabsContent value="quota">
              {quotaError ? (
                <p role="alert">{formatApiError(quotaError)}</p>
              ) : quotaLoading ? (
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
