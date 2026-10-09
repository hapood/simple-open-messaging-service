import type { ConversationItem } from '../../services/model';
import {
  unevidencedProfileDemand,
  type UnevidencedProfileDemand,
} from '../../../../../shared/profile-demand';
import { UserAvatarType } from './model';

/**
 * Derive `<app-user-avatar>` inputs from a {@link ConversationItem}. The single source of truth shared by
 * every surface that renders a conversation avatar (the conversation list, the empty-thread hero, …) so the
 * selected profile evidence stays identical across surfaces, so each surface reads
 * the same digest-addressed avatar bytes.
 *
 * Pure functions (no `this`): safe to assign as component fields for template use, and trivially unit-testable.
 */
export function conversationAvatarType(t: ConversationItem): UserAvatarType {
  return t.type === 'P2P' ? UserAvatarType.OTHER : UserAvatarType.GROUP;
}

export function conversationAvatarAccount(t: ConversationItem): string {
  return t.type === 'P2P' ? t.peerUser.account : t.group.account;
}

export function conversationAvatarNamespaceId(t: ConversationItem): number {
  return t.type === 'P2P' ? t.peerUser.namespaceId : t.group.namespaceId;
}

export function conversationAvatarSrc(
  t: ConversationItem,
): string | null | undefined {
  return t.type === 'P2P' ? t.peerUser.avatar : t.group.avatar;
}

/** Thread-projection profile demand. A conversation subject's `profileRev`
 *  comes from the thread feed, not from any disclosure evidence, so the
 *  demand resolves from caches only: the client IndexedDB, then the server's
 *  durable cache. A miss falls back to the account/address identity instead
 *  of re-fetching from the federated source. */
export function conversationAvatarEvidence(
  t: ConversationItem,
): UnevidencedProfileDemand | undefined {
  if (t.profileRev < 1) return undefined;
  const subject = t.type === 'P2P' ? t.peerUser : t.group;
  return unevidencedProfileDemand({
    publisherNamespaceId: subject.namespaceId,
    lookup: 'ACCOUNT_PROFILE',
    target: {
      profileNamespaceId: subject.namespaceId,
      account: subject.account,
      rev: t.profileRev,
    },
  });
}
