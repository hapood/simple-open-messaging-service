import type { GroupJoinRequest } from './group.service';

export type GroupJoinRequestAction = 'ACCEPT' | 'REJECT';

/** Apply a local manager decision without dropping list history. Server projections remain
 * authoritative; a later page refresh replaces this optimistic terminal state by feedId. */
export function applyGroupJoinRequestAction(
  current: GroupJoinRequest,
  action: GroupJoinRequestAction,
): GroupJoinRequest {
  if (current.status !== 'REQUESTED') return current;
  return {
    ...current,
    status: action === 'ACCEPT' ? 'ACCEPTED' : 'REVOKED',
  };
}

/** Newer projection coordinates win; equal coordinates are idempotent. */
export function mergeGroupJoinRequestPage(
  current: readonly GroupJoinRequest[],
  incoming: readonly GroupJoinRequest[],
): GroupJoinRequest[] {
  const byApplicant = new Map<string, GroupJoinRequest>(
    current.map((row) => [JSON.stringify([row.account, row.domain]), row] as const),
  );
  for (const row of incoming) {
    const key = JSON.stringify([row.account, row.domain]);
    const previous = byApplicant.get(key);
    if (!previous || row.feedId >= previous.feedId) byApplicant.set(key, row);
  }
  return [...byApplicant.values()].sort((a, b) => b.feedId - a.feedId);
}
