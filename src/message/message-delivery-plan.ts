export interface FeedRecipientCandidate {
  userId: number;
  isLocal: boolean;
  isDeleted: boolean;
  authorized: boolean;
}

export interface LiveRecipientCandidate {
  userId: number;
  blocked: boolean;
}

/** Pure recipient policy. Database access and authorization evaluation happen before this function. */
export function planFeedRecipientIds(
  candidates: readonly FeedRecipientCandidate[],
): number[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.isLocal && !candidate.isDeleted && candidate.authorized,
    )
    .map((candidate) => candidate.userId);
}

/** Thread Feed and Push wake every unblocked audience member, including the
 * sender. Mute is a client presentation preference, not a delivery filter. */
export function planLiveDelivery(
  candidates: readonly LiveRecipientCandidate[],
): { wakeUserIds: number[]; pushUserIds: number[] } {
  const live = candidates.filter((candidate) => !candidate.blocked);
  return {
    wakeUserIds: live.map((candidate) => candidate.userId),
    pushUserIds: live.map((candidate) => candidate.userId),
  };
}
