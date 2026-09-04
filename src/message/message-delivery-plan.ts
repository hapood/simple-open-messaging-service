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
): number[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.isLocal && !candidate.isDeleted && candidate.authorized,
    )
    .map((candidate) => candidate.userId);
}

/** Pure local delivery policy. State Feed wake-ups cover every unblocked recipient; notification Push
 * additionally respects mute settings and suppresses delivery back to a message's creator. */
export function planLiveDelivery(
  candidates: readonly LiveRecipientCandidate[],
  creatorId: number | null,
): { wakeUserIds: number[]; pushUserIds: number[] } {
  const live = candidates.filter((candidate) => !candidate.blocked);
  return {
    wakeUserIds: live.map((candidate) => candidate.userId),
    pushUserIds: live
      .filter((candidate) => !candidate.muted && candidate.userId !== creatorId)
      .map((candidate) => candidate.userId),
  };
}
