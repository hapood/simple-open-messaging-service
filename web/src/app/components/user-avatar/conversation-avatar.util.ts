import type { ConversationItem } from '../../services/model';
import type { ProfileSelector } from '../../../../../shared/profile-selector';
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

export function conversationAvatarAccount(t: ConversationItem): string {
  return t.type === 'P2P' ? t.peerUser.account : t.group.account;
}

export function conversationAvatarDomain(
  t: ConversationItem,
): string | undefined {
  if (t.type === 'P2P')
    return t.peerUser.domain !== 'local' ? t.peerUser.domain : undefined;
  return t.group.domain ?? undefined;
}

export function conversationAvatarSrc(
  t: ConversationItem,
): string | null | undefined {
  return t.type === 'P2P' ? t.peerUser.avatar : t.group.avatar;
}

export function conversationAvatarEvidence(
  t: ConversationItem,
): ProfileSelector | undefined {
  if (t.type === 'P2P')
    return t.peerUser.profileRev > 0
      ? {
          type: 'EXACT',
          account: t.peerUser.account,
          domain: t.peerUser.domain,
          rev: t.peerUser.profileRev,
        }
      : undefined;
  return t.group.profileRev > 0
    ? {
        type: 'GROUP_META',
        threadId: t.threadId,
        profileRev: t.group.profileRev,
        subject: { type: 'GROUP' },
      }
    : undefined;
}
