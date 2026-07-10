import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Activity, MoreHorizontal, Search } from 'lucide-react'
import { useFederationPeers, useBlockFederationPeer, useUnblockFederationPeer } from '@/hooks/use-federation'
import { useListParams } from '@/hooks/use-list-params'
import { useIsSuperAdmin } from '@/hooks/use-me'
import type { FederationTrustLevel } from '@/types/api'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Pagination } from '@/components/common/pagination'
import { TableBodyState } from '@/components/common/table-state'
import { formatApiError } from '@/lib/format-error'
import { Timestamp } from '@/components/common/timestamp'
import { PeerStatusBadge } from './peer-status-badge'

const PAGE_SIZE = 20
const FILTERS: (FederationTrustLevel | undefined)[] = [
  undefined,
  'trusted',
  'demoted',
  'pending',
  'blocked',
]

/** The federated-peer lifecycle list. URL-synced (search/page/status shareable + back-safe). A row
 *  opens the routed peer detail (`/federation/:domain`); the ⌄ menu offers a quick Block/Unblock
 *  (super-admin only — block is SUPER_ADMIN-gated on the backend). */
export function FederationPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { searchInput, setSearchInput, search, page, setPage, filter, setFilter, skip, take } =
    useListParams({ pageSize: PAGE_SIZE, filterParam: 'status' })
  const status = (filter || undefined) as FederationTrustLevel | undefined

  const { data, isLoading, isFetching, error } = useFederationPeers({
    skip,
    take,
    search: search || undefined,
    status,
  })
  const block = useBlockFederationPeer()
  const unblock = useUnblockFederationPeer()
  const isSuper = useIsSuperAdmin()

  const onToggleBlock = async (domain: string, blocked: boolean) => {
    try {
      if (blocked) {
        await unblock.mutateAsync(domain)
        toast.success(t('federation.toast.unblocked'))
      } else {
        await block.mutateAsync({ domain })
        toast.success(t('federation.toast.blocked'))
      }
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  const total = data?.total ?? 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('federation.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('federation.desc')}</p>
        </div>
        <Link to="/federation/self-check" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <Activity className="size-4" />
          {t('federation.selfCheck.entry')}
        </Link>
      </div>

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
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder={t('federation.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('federation.col.domain')}</TableHead>
              <TableHead className="w-24">{t('federation.col.status')}</TableHead>
              <TableHead>{t('federation.col.lastSuccess')}</TableHead>
              <TableHead className="w-20">{t('federation.col.demotions')}</TableHead>
              <TableHead>{t('federation.col.created')}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={6}
              emptyMessage={t('federation.empty')}
            >
              {data?.list.map((p) => (
                <TableRow
                  key={p.domain}
                  className="cursor-pointer"
                  onClick={() => navigate(`/federation/${encodeURIComponent(p.domain)}`)}
                >
                  <TableCell className="font-mono text-sm">{p.domain}</TableCell>
                  <TableCell>
                    <PeerStatusBadge level={p.trustLevel} />
                  </TableCell>
                  <TableCell>
                    <Timestamp value={p.lastSuccessAt} />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {p.demotionCount}
                  </TableCell>
                  <TableCell>
                    <Timestamp value={p.createdAt} />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                        disabled={isFetching}
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => navigate(`/federation/${encodeURIComponent(p.domain)}`)}
                        >
                          {t('federation.action.viewTimeline')}
                        </DropdownMenuItem>
                        {isSuper ? (
                          <DropdownMenuItem
                            variant={p.trustLevel === 'blocked' ? undefined : 'destructive'}
                            onClick={() => onToggleBlock(p.domain, p.trustLevel === 'blocked')}
                          >
                            {p.trustLevel === 'blocked'
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
        <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </div>
    </div>
  )
}
