import type { DatabaseTransaction } from '../../database/database.service.js';
import type { PendingClientStateFeedUpdate } from '../../client-state-feed/client-state-feed.service.js';
import type {
  RequestBucket,
  RequestEndpoint,
  RequestKind,
  RequestPage,
} from '../../../shared/relationship-request.js';
import type { RequestProjectionStatusValue } from '../../../shared/request-projection-status.js';
import type { RequestSnapshot } from '../../../shared/request-snapshot.js';

/** Storage coordinates remain bigint until response construction. */
export interface RequestFlow {
  readonly kind: RequestKind;
  readonly author: RequestEndpoint;
  readonly receiver: RequestEndpoint;
}

/** Immutable evidence captured when this node first observes a visible round. */
export interface RequestRoundEvidence {
  readonly authorProfileNamespaceId: number;
  readonly authorProfileRev: number;
  readonly note: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
  /** Required for namespace-zero authors, null for remote authors. */
  readonly snapshot: RequestSnapshot | null;
}

export interface StoredRequestRound extends RequestFlow, RequestRoundEvidence {
  readonly id: bigint;
  readonly status: RequestProjectionStatusValue;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The existing intent state machine determines admission under its locks.
 * This command does not supply a separate NEW/RETRY decision or old pointer.
 * Evidence is used only for a newly admitted round, never to refresh a retry. */
export interface OpenRequestCommand {
  readonly flow: RequestFlow;
  readonly evidence: RequestRoundEvidence;
}

/** Hints captured inside the transaction, delivered only after successful commit.
 * Group manager notification heads continue through existing ThreadFeed fan-out.
 * Protocol PeerStateFeed effects stay owned by the intent command, not this port. */
export interface RequestCommitEffects {
  readonly clientUpdates: readonly PendingClientStateFeedUpdate[];
}

export type OpenRequestResult =
  | {
      readonly status: 'CREATED' | 'UNCHANGED';
      readonly round: StoredRequestRound;
      readonly effects: RequestCommitEffects;
    }
  | { readonly status: 'STALE_REQUEST' };

export type RequestConclusionCause =
  | 'ACCEPT'
  | 'REJECT'
  | 'WITHDRAW'
  | 'EXPIRE';

export interface ConcludeRequestCommand {
  readonly flow: RequestFlow;
  readonly requestId: bigint;
  /** Decided by the owning intent operation, never inferred from REVOKED alone. */
  readonly cause: RequestConclusionCause;
}

export type ConcludeRequestResult =
  | { readonly status: 'CHANGED'; readonly round: StoredRequestRound }
  | { readonly status: 'STALE_REQUEST' };

/** Internal scope selected by the application authorization layer in the same
 * transaction/snapshot. This structural type is not an authorization token and
 * must never be constructed by deserializing a caller-supplied scope. */
export type AuthorizedRequestPageScope =
  | {
      readonly type: 'PERSONAL';
      readonly userId: number;
      readonly account: string;
      readonly bucket: RequestBucket;
    }
  | {
      readonly type: 'GROUP';
      readonly actorUserId: number;
      readonly groupId: number;
      readonly group: RequestEndpoint;
      readonly direction: 'APPLICATION' | 'INVITATION';
    };

export interface RequestPageWindow {
  readonly before: bigint | null;
  readonly take: number;
  /** Captured server time, never accepted from HTTP input. */
  readonly asOf: Date;
}

export interface StoredIncomingRequestHead {
  readonly requestEndId: bigint;
  readonly requestReadId: bigint;
}

export type MarkIncomingRequestsReadResult =
  | {
      readonly status: 'CHANGED' | 'UNCHANGED';
      readonly head: StoredIncomingRequestHead;
      readonly effects: RequestCommitEffects;
    }
  | { readonly status: 'READ_AHEAD'; readonly head: StoredIncomingRequestHead };

/** Definition-only domain port: deliberately has no default/no-op provider.
 *
 * Writes run within the owning intent transaction. Its coordinator acquires
 * affected account scopes, then pair/group/intent resources in the established
 * order before calling these methods. No helper commits, opens an independent
 * transaction, publishes SSE, or schedules network work. Existing raw-SQL intent
 * statements must preserve the same semantics when composing their CTEs.
 */
export abstract class RequestTransactionCapability {
  /** Reuse the existing intent state machine for round admission. A new round
   * inserts immutable evidence and sets intent.requestId atomically, retaining
   * older request history. Allocate after scope locks and advance only new
   * recipient/manager heads. A same-round authoring retry reuses the associated
   * round without changing evidence or notification heads. Never fabricate a
   * visible round for founding transitions or unseen historical revocations. */
  abstract openRequestInTx(
    tx: DatabaseTransaction,
    command: OpenRequestCommand,
  ): Promise<OpenRequestResult>;

  /** Find the intent by its requestId and verify flow and authorization under
   * the existing business locks. Missing association or terminal intent state
   * fails as STALE_REQUEST, not successful idempotence or address-based fallback.
   * Only REQUESTED admits a request decision; ACCEPTED (ACK) and REVOKED are
   * terminal for that round. Apply the intent transition and request conclusion
   * in the same transaction. Accepted requests stay accepted when friendship is
   * later ended: established-relationship revocation must not call this method.
   * Replayed terminal protocol facts must not overwrite the original conclusion.
   * Conclusion never advances incoming or manager new-request heads.
   * The owner checks effective expiry; EXPIRE requires an elapsed deadline. */
  abstract concludeRequestInTx(
    tx: DatabaseTransaction,
    command: ConcludeRequestCommand,
  ): Promise<ConcludeRequestResult>;

  /** Pure effective-status calculation; no persistence, GC, or notification. */
  abstract requestStatusAt(
    round: Pick<StoredRequestRound, 'status' | 'expiresAt'>,
    asOf: Date,
  ): RequestProjectionStatusValue;

  /** Execute only inside the application's read-only consistent snapshot after
   * scope authorization. Use createdAt >= asOf - seven days, id < before,
   * descending IDs and take+1. No caller-selected historical lower boundary.
   * The application reads the accompanying personal/manager head in the same
   * snapshot. Missing exact presentation must not invent a current-profile
   * fallback. Response construction converts IDs losslessly to decimal strings. */
  abstract queryRequestPage(
    tx: DatabaseTransaction,
    scope: AuthorizedRequestPageScope,
    window: RequestPageWindow,
  ): Promise<RequestPage>;

  /** Under the account scope lock, advance only confirmed read monotonically.
   * Reject a negative target or a target above end without writing. Read-ahead
   * maps to application validation failure, not a successful clamp. Publish a
   * complete head in the same transaction only when it changed; return wake
   * hints for post-commit delivery. No optimistic or SENT state is stored here. */
  abstract markIncomingRequestsReadInTx(
    tx: DatabaseTransaction,
    userId: number,
    requestReadId: bigint,
  ): Promise<MarkIncomingRequestsReadResult>;
}
