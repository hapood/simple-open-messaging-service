import { useTranslation } from 'react-i18next';
import type { FederationPeerState } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PeerCoordinate, PeerMeta, PeerTime } from './peer-detail-primitives';

/** Inbound committed progress and the latest received hint use the same publisher coordinates.
 * Outbound state allocation belongs to a different stream and is deliberately separate. */
export function PeerFeedPanel({ peer }: { peer: FederationPeerState }) {
  const { t } = useTranslation();
  const progress = peer.feedProgress;
  const receipt = peer.latestFeedHeadReceipt;
  const rows = [
    {
      name: t('federation.feed.state'),
      through: progress.inboundStateFeedPulledThrough,
      generatedAt: progress.stateFeedSourceGeneratedAt,
      end: receipt?.stateFeedEndId,
    },
    {
      name: t('federation.feed.profileNamespace'),
      through: progress.inboundProfileNamespaceFeedPulledThrough,
      generatedAt: progress.profileNamespaceFeedSourceGeneratedAt,
      end: receipt?.profileNamespaceFeedEndId,
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('federation.feed.title')}</CardTitle>
        <p className="text-sm leading-[20px] text-muted-foreground">
          {t('federation.inspect.feedDirection', {
            domain: peer.domain,
            namespaceId: progress.namespaceId,
          })}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead rowSpan={2}>Feed</TableHead>
                <TableHead colSpan={2}>
                  {t('federation.inspect.processed')}
                </TableHead>
                <TableHead>{t('federation.receipt.title')}</TableHead>
              </TableRow>
              <TableRow>
                <TableHead>{t('federation.inspect.processedId')}</TableHead>
                <TableHead>
                  {t('federation.inspect.sourceGeneratedAt')}
                </TableHead>
                <TableHead>{t('federation.inspect.pushedEndId')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.name}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>
                    {row.through === null ? (
                      t('federation.feed.notStarted')
                    ) : (
                      <PeerCoordinate value={row.through} />
                    )}
                  </TableCell>
                  <TableCell>
                    <PeerTime value={row.generatedAt} />
                  </TableCell>
                  <TableCell>
                    <PeerCoordinate value={row.end} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs leading-[20px] text-muted-foreground">
          {t('federation.inspect.scanHint')}
        </p>
        <div className="rounded-md border bg-muted/30 p-4">
          {receipt ? (
            <div className="grid gap-4 lg:grid-cols-3">
              <PeerMeta label={t('federation.receipt.generatedAt')}>
                <PeerTime value={receipt.generatedAt} />
              </PeerMeta>
              <PeerMeta label={t('federation.receipt.sentAt')}>
                <PeerTime value={receipt.sentAt} />
              </PeerMeta>
              <PeerMeta label={t('federation.receipt.receivedAt')}>
                <PeerTime value={receipt.receivedAt} />
              </PeerMeta>
            </div>
          ) : (
            <p className="text-sm leading-[20px] text-muted-foreground">
              {t('federation.receipt.empty')}
            </p>
          )}
          <p className="mt-3 text-xs leading-[20px] text-muted-foreground">
            {t('federation.receipt.description')}
          </p>
        </div>
        <div className="border-t pt-4">
          <PeerMeta label={t('federation.feed.localOutboundEnd')}>
            <PeerCoordinate value={progress.outboundStateFeedEndId} />
          </PeerMeta>
          <p className="mt-1 text-xs leading-[20px] text-muted-foreground">
            {t('federation.inspect.outboundHint')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
