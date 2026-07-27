import type { ConversationItem } from '../../services/model';
import { UserAvatarType } from './model';

/**
 * Derive `<app-user-avatar>` inputs from a {@link ConversationItem}. The single source of truth shared by
 * every surface that renders a conversation avatar (the conversation list, the empty-thread hero, …) so the
 * IDB cache key (`u<id>` for P2P, `g<id>` for a group) and the avatar source stay identical across surfaces —
 * a cached / aliased avatar renders the same everywhere.
 *
 * Pure functions (no `this`): safe to assign as component fields for template use, and trivially unit-testable.
 */
export function conversationAvatarType(t: ConversationItem): UserAvatarType {
  return t.type === 'P2P' ? UserAvatarType.OTHER : UserAvatarType.GROUP;
}

export function conversationAvatarIdentityId(t: ConversationItem): number {
  return t.type === 'P2P' ? t.peerUser.id : t.group.id;
}

export function conversationAvatarSrc(t: ConversationItem): string | null | undefined {
  return t.type === 'P2P' ? t.peerUser.avatar : t.group.avatar;
}
