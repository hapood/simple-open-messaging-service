export interface FeedRecipientCandidate {
  userId: number;
  isLocal: boolean;
  isDeleted: boolean;
  authorized: boolean;
}

export interface LiveRecipientCandidate {
  userId: number;
  muted: boolean;
  blocked: boolean;
}

/** Pure recipient policy. Database access and authorization evaluation happen before this function. */
export function planFeedRecipientIds(
  candidates: readonly FeedRecipientCandidate[],
  creatorId: number | null,
): number[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.isLocal &&
        !candidate.isDeleted &&
        candidate.authorized &&
        candidate.userId !== creatorId,
    )
    .map((candidate) => candidate.userId);
}

/** Pure local wake-up policy. SSE synchronizes every unblocked recipient; notification Push additionally
 * respects mute and suppresses a user-authored message for its creator. */
export function planLiveDelivery(
  candidates: readonly LiveRecipientCandidate[],
  creatorId: number | null,
): { sseUserIds: number[]; pushUserIds: number[] } {
  const live = candidates.filter((candidate) => !candidate.blocked);
  return {
    sseUserIds: live.map((candidate) => candidate.userId),
    pushUserIds: live
      .filter((candidate) => !candidate.muted && candidate.userId !== creatorId)
      .map((candidate) => candidate.userId),
  };
}
