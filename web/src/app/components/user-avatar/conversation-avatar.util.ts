import type { ConversationItem } from '../../services/model';
import type { ProfileSelector } from '../../../../../shared/profile-selector';
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
  if (t.profileRev < 1) return undefined;
  // Thread type comes from the authenticated state feed. The profile-resolution
  // endpoint independently checks that the selector belongs to this thread.
  return t.type === 'P2P'
    ? {
        type: 'EXACT',
        account: t.peerUser.account,
        domain: t.peerUser.domain,
        rev: t.profileRev,
      }
    : {
        type: 'GROUP_META',
        threadId: t.threadId,
        profileRev: t.profileRev,
        subject: { type: 'GROUP' },
      };
}
