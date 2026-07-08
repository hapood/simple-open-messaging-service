import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Timestamp } from '@/components/common/timestamp'
import { formatApiError } from '@/lib/format-error'
import {
  useFederationPeerEvents,
  useBlockFederationPeer,
  useUnblockFederationPeer,
} from '@/hooks/use-federation'
import type { FederatedPeer } from '@/types/api'
import { PeerStatusBadge } from './peer-status-badge'
import { PeerTimeline } from './peer-timeline'

/** Peer detail: current lifecycle metadata + the full transition timeline + the Block/Unblock action.
 *  Open while `peer != null`; the events query is enabled on the domain. Block/Unblock invalidate the
 *  federation namespace, so both the list and this timeline refetch after the action. */
export function PeerDetailDialog({
  peer,
  onClose,
}: {
  peer: FederatedPeer | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { data: events, isLoading } = useFederationPeerEvents(peer?.domain ?? null)
  const block = useBlockFederationPeer()
  const unblock = useUnblockFederationPeer()

  const blocked = peer?.trustLevel === 'blocked'
  const onToggleBlock = async () => {
    if (!peer) return
    try {
      if (blocked) {
        await unblock.mutateAsync(peer.domain)
        toast.success(t('federation.toast.unblocked'))
      } else {
        await block.mutateAsync({ domain: peer.domain })
        toast.success(t('federation.toast.blocked'))
      }
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  return (
    <Dialog open={peer !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono text-base">{peer?.domain}</span>
            {peer ? <PeerStatusBadge level={peer.trustLevel} /> : null}
          </DialogTitle>
        </DialogHeader>

        {peer ? (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <Meta label={t('federation.meta.createdAt')}>
                <Timestamp value={peer.createdAt} />
              </Meta>
              <Meta label={t('federation.meta.trustedAt')}>
                <Timestamp value={peer.trustedAt} />
              </Meta>
              <Meta label={t('federation.meta.lastSuccessAt')}>
                <Timestamp value={peer.lastSuccessAt} />
              </Meta>
              <Meta label={t('federation.meta.demotedAt')}>
                <Timestamp value={peer.demotedAt} />
              </Meta>
              <Meta label={t('federation.meta.demotionCount')}>{peer.demotionCount}</Meta>
              <Meta label={t('federation.meta.addedBy')}>
                {peer.addedBy ?? t('federation.meta.auto')}
              </Meta>
              {peer.demoteReason ? (
                <div className="col-span-2">
                  <Meta label={t('federation.meta.lastError')}>
                    <span className="break-all text-destructive">{peer.demoteReason}</span>
                  </Meta>
                </div>
              ) : null}
            </div>

            <div>
              <div className="mb-2 text-sm font-medium">{t('federation.timeline.title')}</div>
              {isLoading ? (
                <div className="py-4 text-sm text-muted-foreground">{t('common.loading')}</div>
              ) : (
                <PeerTimeline events={events ?? []} />
              )}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={blocked ? 'default' : 'destructive'}
            onClick={onToggleBlock}
            disabled={!peer || block.isPending || unblock.isPending}
          >
            {blocked ? t('federation.action.unblock') : t('federation.action.block')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  )
}
