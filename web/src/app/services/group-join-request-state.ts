import { RequestProjectionStatus } from '../../../../shared/request-projection-status';
import type { RequestRecord } from '../../../../shared/relationship-request';

export type GroupJoinRequestAction = 'ACCEPT' | 'REJECT';

export interface GroupJoinRequestAttention {
  joinRequestEndFeedId?: number;
  joinRequestReadFeedId?: number;
}

/** A read watermark of -1 disables manager-only attention. Zero remains a
 * valid manager position so the first application (end 1) is visible. */
export function hasUnreadGroupJoinRequests(
  attention: GroupJoinRequestAttention | null | undefined,
): boolean {
  const end = attention?.joinRequestEndFeedId ?? 0;
  const read = attention?.joinRequestReadFeedId ?? -1;
  return read >= 0 && read < end;
}

/** Apply a local manager decision without dropping round history. Server records
 * remain authoritative; a later page refresh replaces this optimistic terminal
 * state by exact request id. */
export function applyGroupJoinRequestAction(
  current: RequestRecord,
  action: GroupJoinRequestAction,
): RequestRecord {
  if (current.status !== 'REQUESTED') return current;
  return {
    ...current,
    status:
      action === 'ACCEPT'
        ? RequestProjectionStatus.ACCEPTED
        : RequestProjectionStatus.REJECTED,
  };
}

/** Rounds are keyed by their permanent request id; one identity may own several
 * historical rounds in the visible window. Equal ids are idempotent refreshes. */
export function mergeGroupJoinRequestPage(
  current: readonly RequestRecord[],
  incoming: readonly RequestRecord[],
): RequestRecord[] {
  const byId = new Map<string, RequestRecord>(
    current.map((row) => [row.id, row] as const),
  );
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) =>
    BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0,
  );
}
