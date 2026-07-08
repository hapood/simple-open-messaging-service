import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { MoreHorizontal, Search } from 'lucide-react'
import { useFederationPeers, useBlockFederationPeer, useUnblockFederationPeer } from '@/hooks/use-federation'
import type { FederatedPeer, FederationTrustLevel } from '@/types/api'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
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
import { Timestamp } from '@/components/common/timestamp'
import { formatApiError } from '@/lib/format-error'
import { PeerStatusBadge } from './peer-status-badge'
import { PeerDetailDialog } from './peer-detail-dialog'

const PAGE_SIZE = 20
const FILTERS: (FederationTrustLevel | undefined)[] = [
  undefined,
  'trusted',
  'demoted',
  'pending',
  'blocked',
]

/** The federated-peer lifecycle page. Lists every peer domain with its current trust state + the
 *  liveness/demotion audit columns; a status filter + search narrow it. Row → detail dialog with the
 *  full transition timeline; the ⌄ menu offers a quick Block/Unblock. */
export function FederationPage() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState<FederationTrustLevel | undefined>(undefined)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<FederatedPeer | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search)
      setPage(0)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  const { data, isLoading, isFetching, error } = useFederationPeers({
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE,
    search: debounced || undefined,
    status,
  })
  const block = useBlockFederationPeer()
  const unblock = useUnblockFederationPeer()

  const onToggleBlock = async (p: FederatedPeer) => {
    try {
      if (p.trustLevel === 'blocked') {
        await unblock.mutateAsync(p.domain)
        toast.success(t('federation.toast.unblocked'))
      } else {
        await block.mutateAsync({ domain: p.domain })
        toast.success(t('federation.toast.blocked'))
      }
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('federation.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('federation.desc')}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((s) => (
            <Button
              key={s ?? 'all'}
              variant={status === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setStatus(s)
                setPage(0)
              }}
            >
              {s ? t(`federation.status.${s}`) : t('federation.status.all')}
            </Button>
          ))}
        </div>
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder={t('federation.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : error ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-destructive">
                  {t('common.loadFailed', { message: formatApiError(error) })}
                </TableCell>
              </TableRow>
            ) : data?.list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  {t('federation.empty')}
                </TableCell>
              </TableRow>
            ) : (
              data?.list.map((p) => (
                <TableRow
                  key={p.domain}
                  className="cursor-pointer"
                  onClick={() => setSelected(p)}
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
                        <DropdownMenuItem onClick={() => setSelected(p)}>
                          {t('federation.action.viewTimeline')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onToggleBlock(p)}>
                          {p.trustLevel === 'blocked'
                            ? t('federation.action.unblock')
                            : t('federation.action.block')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{t('federation.total', { count: total })}</span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            {t('common.previous')}
          </Button>
          <span>{t('common.page', { page: page + 1, pages: pageCount })}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('common.next')}
          </Button>
        </div>
      </div>

      <PeerDetailDialog peer={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
