import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { MoreHorizontal, Search } from 'lucide-react';
import {
  useFederationPeers,
  useBlockFederationPeer,
  useUnblockFederationPeer,
} from '@/hooks/use-federation';
import { useListParams } from '@/hooks/use-list-params';
import { useIsSuperAdmin } from '@/hooks/use-me';
import { useQuotaNodes } from '@/hooks/use-quotas';
import type { FederationPeerState, FederationTrustLevel } from '@/types/api';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Pagination } from '@/components/common/pagination';
import { TableBodyState } from '@/components/common/table-state';
import { formatApiError } from '@/lib/format-error';
import { Timestamp } from '@/components/common/timestamp';
import { PeerStatusBadge } from './peer-status-badge';
import { quotaRisk } from './peer-quota-panel';

const PAGE_SIZE = 20;
const FILTERS: (FederationTrustLevel | undefined)[] = [
  undefined,
  'unrecognized',
  'establishing',
  'available',
  'degraded',
  'halted',
];

/** The federated-peer lifecycle list. URL-synced (search/page/status shareable + back-safe). A row
 *  opens the routed peer detail (`/federation/:domain`); the ⌄ menu offers a quick Block/Unblock
 *  (super-admin only — block is SUPER_ADMIN-gated on the backend). */
export function FederationPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    searchInput,
    setSearchInput,
    search,
    page,
    setPage,
    filter,
    setFilter,
    skip,
    take,
  } = useListParams({ pageSize: PAGE_SIZE, filterParam: 'status' });
  const [params, setParams] = useSearchParams();
  const namespaceIdParam = params.get('nsid') ?? '';
  const namespaceId = /^[1-9]\d*$/.test(namespaceIdParam)
    ? Number(namespaceIdParam)
    : undefined;
  const status = (filter || undefined) as FederationTrustLevel | undefined;

  const { data, isLoading, isFetching, error } = useFederationPeers({
    skip,
    take,
    search: search || undefined,
    status,
    namespaceId,
  });
  const block = useBlockFederationPeer();
  const unblock = useUnblockFederationPeer();
  const isSuper = useIsSuperAdmin();
  const {
    data: quotaNodes,
    isPending: quotaPending,
    error: quotaError,
  } = useQuotaNodes();
  const quotaByNamespace = new Map(
    (quotaNodes ?? []).map((node) => [node.namespaceId, node]),
  );

  const onToggleBlock = async (domain: string, blocked: boolean) => {
    try {
      if (blocked) {
        await unblock.mutateAsync(domain);
        toast.success(t('federation.toast.unblocked'));
      } else {
        await block.mutateAsync({ domain });
        toast.success(t('federation.toast.blocked'));
      }
    } catch (e) {
      toast.error(formatApiError(e));
    }
  };

  const total = data?.total ?? 0;

  const setNamespaceId = (value: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const normalized = value.trim();
        if (/^[1-9]\d*$/.test(normalized)) next.set('nsid', normalized);
        else next.delete('nsid');
        next.delete('p');
        return next;
      },
      { replace: true },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((s) => (
            <Button
              key={s ?? 'all'}
              variant={status === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter(s ?? '')}
            >
              {s ? t(`federation.status.${s}`) : t('federation.status.all')}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-72">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder={t('federation.searchPlaceholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-8"
            />
          </div>
          <Input
            className="w-32"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder={t('federation.namespaceFilterPlaceholder')}
            value={namespaceIdParam}
            onChange={(e) => setNamespaceId(e.target.value)}
          />
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('federation.col.domain')}</TableHead>
              <TableHead className="w-24">
                {t('federation.col.status')}
              </TableHead>
              <TableHead className="w-28">
                {t('federation.col.quota')}
              </TableHead>
              <TableHead>{t('federation.col.lastSuccess')}</TableHead>
              <TableHead className="w-20">
                {t('federation.col.degradations')}
              </TableHead>
              <TableHead className="w-40">
                {t('federation.col.feedProgress')}
              </TableHead>
              <TableHead>{t('federation.col.created')}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={8}
              emptyMessage={t('federation.empty')}
            >
              {data?.list.map((p) => (
                <TableRow
                  key={p.domain}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate(`/federation/${encodeURIComponent(p.domain)}`)
                  }
                >
                  <TableCell className="font-mono text-sm">
                    {p.domain}
                  </TableCell>
                  <TableCell>
                    <PeerStatusBadge level={p.trustLevel} />
                  </TableCell>
                  <TableCell>
                    {!p.active ? (
                      <Badge variant="outline">
                        {t('quota.notApplicable')}
                      </Badge>
                    ) : quotaError ? (
                      <Badge variant="destructive">
                        {t('quotaCenter.loadFailed')}
                      </Badge>
                    ) : quotaPending ? (
                      <span>{t('common.loading')}</span>
                    ) : (
                      <QuotaHealth
                        risk={quotaRisk(quotaByNamespace.get(p.id))}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <Timestamp value={p.lastSuccessAt} />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {p.degradationCount}
                  </TableCell>
                  <TableCell>
                    <FeedProgressSummary peer={p} />
                  </TableCell>
                  <TableCell>
                    <Timestamp value={p.createdAt} />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className={buttonVariants({
                          variant: 'ghost',
                          size: 'icon',
                        })}
                        disabled={isFetching}
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() =>
                            navigate(
                              `/federation/${encodeURIComponent(p.domain)}`,
                            )
                          }
                        >
                          {t('federation.action.viewDetail')}
                        </DropdownMenuItem>
                        {isSuper ? (
                          <DropdownMenuItem
                            variant={
                              p.trustLevel === 'halted' && p.haltCode === 50009
                                ? undefined
                                : 'destructive'
                            }
                            onClick={() =>
                              onToggleBlock(
                                p.domain,
                                p.trustLevel === 'halted' &&
                                  p.haltCode === 50009,
                              )
                            }
                          >
                            {p.trustLevel === 'halted' && p.haltCode === 50009
                              ? t('federation.action.unblock')
                              : t('federation.action.block')}
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBodyState>
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{t('federation.total', { count: total })}</span>
        <Pagination
          page={page}
          total={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}

function QuotaHealth({ risk }: { risk: number | undefined }) {
  const { t } = useTranslation();
  if (risk === undefined)
    return <Badge variant="outline">{t('quota.unavailable')}</Badge>;
  const label = risk >= 1 ? 'exhausted' : risk >= 0.8 ? 'warning' : 'healthy';
  const variant =
    risk >= 1 ? 'destructive' : risk >= 0.8 ? 'outline' : 'secondary';
  return <Badge variant={variant}>{t(`quota.health.${label}`)}</Badge>;
}

function FeedProgressSummary({ peer }: { peer: FederationPeerState }) {
  const { t } = useTranslation();
  const state = progressLabel(
    peer.feedProgress.inboundStateFeedPulledThrough,
    peer.feedProgress.outboundStateFeedEndId,
  );
  const profileLag = nonNegativeDiff(
    peer.feedProgress.remoteProfileNamespaceFeedEndId,
    peer.feedProgress.inboundProfileNamespaceFeedPulledThrough,
  );
  const profile =
    profileLag === 0n
      ? t('federation.feed.caughtUp')
      : t('federation.feed.behind', { count: profileLag.toString() });
  return (
    <div className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
      <span title={t('federation.feed.state')}>S {state}</span>
      <span title={t('federation.feed.profileNamespace')}>P {profile}</span>
    </div>
  );
}

function progressLabel(pulled: string | null, end: string) {
  if (pulled === null) return `-/${end}`;
  return `${pulled}/${end}`;
}

function nonNegativeDiff(end: string, pulled: string): bigint {
  const diff = BigInt(end) - BigInt(pulled);
  return diff > 0n ? diff : 0n;
}
