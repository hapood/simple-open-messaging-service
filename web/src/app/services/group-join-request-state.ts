import { RequestProjectionStatus } from '../../../../shared/request-projection-status';
import type { GroupJoinRequest } from './group.service';

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

/** Apply a local manager decision without dropping list history. Server projections remain
 * authoritative; a later page refresh replaces this optimistic terminal state by feedId. */
export function applyGroupJoinRequestAction(
  current: GroupJoinRequest,
  action: GroupJoinRequestAction,
): GroupJoinRequest {
  if (current.status !== 'REQUESTED') return current;
  return {
    ...current,
    status:
      action === 'ACCEPT'
        ? RequestProjectionStatus.ACCEPTED
        : RequestProjectionStatus.REJECTED,
  };
}

/** Newer projection coordinates win; equal coordinates are idempotent. */
export function mergeGroupJoinRequestPage(
  current: readonly GroupJoinRequest[],
  incoming: readonly GroupJoinRequest[],
): GroupJoinRequest[] {
  const byApplicant = new Map<string, GroupJoinRequest>(
    current.map(
      (row) => [JSON.stringify([row.account, row.domain]), row] as const,
    ),
  );
  for (const row of incoming) {
    const key = JSON.stringify([row.account, row.domain]);
    const previous = byApplicant.get(key);
    if (!previous || row.feedId >= previous.feedId) byApplicant.set(key, row);
  }
  return [...byApplicant.values()].sort((a, b) => b.feedId - a.feedId);
}
