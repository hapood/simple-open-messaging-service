import type { ContentType } from '../database/enums.js';
import type { pendingMedia } from '../database/schema.js';

type PendingMediaRow = typeof pendingMedia.$inferSelect;

export type OutboundPendingMediaRow = PendingMediaRow & {
  direction: 'OUTBOUND';
  messageId: null;
  threadId: number;
  creatorAccount: string;
  creatorDomain: string;
  contentType: ContentType;
  content: string;
  originDomain: null;
  expectedAuthorizationEpoch: null;
};

export type InboundPendingMediaRow = PendingMediaRow & {
  direction: 'INBOUND';
  messageId: bigint;
  threadId: null;
  creatorAccount: null;
  creatorDomain: null;
  contentType: null;
  content: null;
  clientMessageId: null;
  originDomain: string;
  namespaceId: number;
  expectedAuthorizationEpoch: number;
};

/** Mirrors PendingMedia_direction_shape_check at application boundaries. */
export function requireOutboundPendingMedia(
  row: PendingMediaRow,
): OutboundPendingMediaRow {
  if (
    row.direction !== 'OUTBOUND' ||
    row.messageId !== null ||
    row.threadId === null ||
    row.creatorAccount === null ||
    row.creatorDomain === null ||
    row.contentType === null ||
    row.content === null ||
    row.originDomain !== null ||
    row.expectedAuthorizationEpoch !== null
  ) {
    throw new Error(`PendingMedia ${row.batchId} has an invalid OUTBOUND shape`);
  }
  return row as OutboundPendingMediaRow;
}

/** Mirrors PendingMedia_direction_shape_check at application boundaries. */
export function requireInboundPendingMedia(
  row: PendingMediaRow,
): InboundPendingMediaRow {
  if (
    row.direction !== 'INBOUND' ||
    row.messageId === null ||
    row.threadId !== null ||
    row.creatorAccount !== null ||
    row.creatorDomain !== null ||
    row.contentType !== null ||
    row.content !== null ||
    row.clientMessageId !== null ||
    row.originDomain === null ||
    row.namespaceId === null ||
    row.expectedAuthorizationEpoch === null
  ) {
    throw new Error(`PendingMedia ${row.batchId} has an invalid INBOUND shape`);
  }
  return row as InboundPendingMediaRow;
}
