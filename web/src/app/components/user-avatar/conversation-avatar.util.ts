import type { ConversationItem } from '../../services/model';
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

// The thread→profile mapping (pinned revision, ACTIVE-linked authorization) lives in
// services/avatar-profile-ref.ts as `conversationAvatarProfile`; components pass the returned
// domain ref to <app-user-avatar [profile]>, which owns the demand form and resolution.
