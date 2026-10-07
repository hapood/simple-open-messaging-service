import type { ConversationItem } from '../../services/model';
import type { ProfileDemand } from '../../../../../shared/profile-demand';
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

/** Federated display domain: a local subject (namespace zero) never shows a marker,
 *  while a federated subject always renders its real federation domain. */
export function conversationAvatarDomain(
  t: ConversationItem,
): string | undefined {
  const subject = t.type === 'P2P' ? t.peerUser : t.group;
  return subject.namespaceId !== 0 ? subject.domain || undefined : undefined;
}

export function conversationAvatarSrc(
  t: ConversationItem,
): string | null | undefined {
  return t.type === 'P2P' ? t.peerUser.avatar : t.group.avatar;
}

export function conversationAvatarEvidence(
  t: ConversationItem,
): ProfileDemand | undefined {
  if (t.profileRev < 1) return undefined;
  const subject = t.type === 'P2P' ? t.peerUser : t.group;
  return {
    publisherNamespaceId: subject.namespaceId,
    lookup: 'ACCOUNT_PROFILE',
    target: {
      profileNamespaceId: subject.namespaceId,
      account: subject.account,
      rev: t.profileRev,
    },
  };
}
