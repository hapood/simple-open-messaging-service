import type { ConversationItem, GroupConversationItem } from './model';
import type { ProfileDemand } from '../../../../shared/profile-demand';
import {
  unevidencedProfileDemand,
  type UnevidencedProfileDemand,
} from '../../../../shared/profile-demand';

/**
 * The domain facts every avatar / identity surface already holds about a profile subject.
 * Resolution mechanics — the evidenced vs cache-only demand form, the subscription, the
 * digest-addressed avatar bytes — stay behind the profile repository and the avatar
 * components. Callers never build demands and never decide the authorization form;
 * `linked` is plain relationship state they already render.
 */
export interface AvatarProfileRef {
  account: string;
  /** Publisher namespace that owns the profile store on this device. */
  publisherNamespaceId: number;
  /** Profile namespace of the subject inside that publisher's store. */
  profileNamespaceId: number;
  /** Thread/request/message-pinned profile revision; < 1 means no pinned profile. */
  rev: number;
  /** A live relationship authorizes cross-server resolution; a severed one renders cache-only. */
  linked: boolean;
  /** Group-roster subject: resolves through the group's own authority instead of the account store. */
  groupAccount?: string;
}

/** Build the resolver demand for a profile ref. Undefined when no revision is pinned. */
export function avatarProfileDemand(
  ref: AvatarProfileRef | undefined,
): ProfileDemand | UnevidencedProfileDemand | undefined {
  if (!ref || !ref.account || ref.rev < 1) return undefined;
  const demand: ProfileDemand = ref.groupAccount
    ? {
        publisherNamespaceId: ref.publisherNamespaceId,
        lookup: 'GROUP_MEMBER_PROFILE',
        target: {
          profileNamespaceId: ref.profileNamespaceId,
          account: ref.account,
          rev: ref.rev,
        },
        groupAccount: ref.groupAccount,
      }
    : {
        publisherNamespaceId: ref.publisherNamespaceId,
        lookup: 'ACCOUNT_PROFILE',
        target: {
          profileNamespaceId: ref.profileNamespaceId,
          account: ref.account,
          rev: ref.rev,
        },
      };
  return ref.linked ? demand : unevidencedProfileDemand(demand);
}

/** Memoized ref objects: avatar/label inputs treat a new reference as a new subject and
 *  re-resolve, so template re-evaluations of an unchanged conversation (every row render)
 *  must reuse the same object until the subject or revision truly changes. Bounded LRU:
 *  a stale subject/revision entry is inert data. */
const refCache = new Map<string, AvatarProfileRef>();
const REF_CACHE_LIMIT = 512;

function memoizeRef(ref: AvatarProfileRef): AvatarProfileRef {
  const key = JSON.stringify([
    ref.linked, ref.publisherNamespaceId, ref.profileNamespaceId,
    ref.account, ref.rev, ref.groupAccount ?? null,
  ]);
  const cached = refCache.get(key);
  if (cached) {
    refCache.delete(key);
    refCache.set(key, cached);
    return cached;
  }
  refCache.set(key, ref);
  if (refCache.size > REF_CACHE_LIMIT)
    refCache.delete(refCache.keys().next().value!);
  return ref;
}

/** Conversation-subject profile ref (thread list, headers, call surfaces, pickers).
 *  A home publisher stores its accounts' profiles at namespace 0 inside its store; the
 *  thread projection's `profileRev` pins the revision. An ACTIVE relationship keeps the
 *  demand authorized while a severed one renders history cache-only. */
export function conversationAvatarProfile(
  t: ConversationItem,
): AvatarProfileRef | undefined {
  if (t.profileRev < 1) return undefined;
  const subject = t.type === 'P2P' ? t.peerUser : t.group;
  return memoizeRef({
    account: subject.account,
    publisherNamespaceId: subject.namespaceId,
    profileNamespaceId: 0,
    rev: t.profileRev,
    linked: t.conversationState === 'ACTIVE',
  });
}

/** Message-author profile ref. The message carries the publisher-scoped subject coordinates. */
export function messageAuthorAvatarProfile(message: {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  profileRev: number;
  creator: { account: string };
}): AvatarProfileRef | undefined {
  if (message.profileRev < 1) return undefined;
  return memoizeRef({
    account: message.creator.account,
    publisherNamespaceId: message.publisherNamespaceId,
    profileNamespaceId: message.profileNamespaceId,
    rev: message.profileRev,
    linked: true,
  });
}

/** Group-roster member ref. The group's authority owns the member profile namespace
 *  and the roster row pins each member's revision. */
export function groupMemberAvatarProfile(
  thread: GroupConversationItem,
  member: { account: string; namespaceId: number; profileRev: number },
): AvatarProfileRef | undefined {
  if (member.profileRev < 1) return undefined;
  return memoizeRef({
    account: member.account,
    publisherNamespaceId: thread.publisherNamespaceId,
    profileNamespaceId: member.namespaceId,
    rev: member.profileRev,
    linked: thread.conversationState === 'ACTIVE',
    groupAccount: thread.group.account,
  });
}
