import type { RequestSnapshot } from './request-snapshot.js';
import type { RequestProjectionStatusValue } from './request-projection-status.js';

/** Decimal PostgreSQL bigint IDs; never parse these through Number. */
export type RequestId = string;

/** Decode untrusted wire coordinates without interpreting round or lifecycle semantics. */
export function requestIdFromWire(value: unknown, allowZero = false): RequestId {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > 19 ||
    BigInt(value) > 9223372036854775807n ||
    (!allowZero && value === '0')
  )
    throw new Error('invalid request ID');
  return value;
}

export function parseIncomingRequestHead(value: unknown): IncomingRequestHead {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid incoming request head');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, 'requestEndId') ||
    !Object.hasOwn(record, 'requestReadId')
  )
    throw new Error('invalid incoming request head');
  const requestEndId = requestIdFromWire(record['requestEndId'], true);
  const requestReadId = requestIdFromWire(record['requestReadId'], true);
  if (BigInt(requestReadId) > BigInt(requestEndId))
    throw new Error('request read ID exceeds end ID');
  return { requestEndId, requestReadId };
}
export interface IncomingRequestHead {
  requestEndId: RequestId;
  requestReadId: RequestId;
}
export type RequestBucket = 'RECEIVED' | 'SENT';
export type RequestKind = 'FRIEND' | 'GROUP_APPLICATION' | 'GROUP_INVITATION';
export interface RequestEndpoint {
  account: string;
  namespaceId: number;
}
export interface RequestAuthorReference extends RequestEndpoint {
  profileNamespaceId: number;
  profileRev: number;
}
export interface RequestRecordBase {
  id: RequestId;
  kind: RequestKind;
  author: RequestEndpoint;
  receiver: RequestEndpoint;
  status: RequestProjectionStatusValue;
  note: string;
  requestedAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
/** ISO timestamps and closed presentation variants; no current-profile fallback. */
export type RequestRecord = RequestRecordBase & (
  | { direction: 'INCOMING'; authorProfile: RequestAuthorReference }
  | { direction: 'OUTGOING'; snapshot: RequestSnapshot }
);
export interface RequestPage {
  items: RequestRecord[];
  hasMore: boolean;
  before: string | null;
}
export interface PersonalRequestPage extends RequestPage {
  incomingHead: IncomingRequestHead;
}
export interface GroupRequestPage extends RequestPage {
  joinRequestEndFeedId: number;
  joinRequestReadFeedId: number;
}
export type RequestDecision = 'ACCEPT' | 'REJECT' | 'WITHDRAW';
export type RequestDecisionResult =
  | { status: 'OK'; threadId: number | null }
  | { status: 'STALE_REQUEST' }
  | { status: 'EXPIRED' };
