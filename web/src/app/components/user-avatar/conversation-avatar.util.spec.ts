import {
  conversationAvatarType,
  conversationAvatarAccount,
  conversationAvatarNamespaceId,
} from './conversation-avatar.util';
import {
  conversationAvatarProfile,
  avatarProfileDemand,
} from '../../services/avatar-profile-ref';
import { UserAvatarType } from './model';
import type { ConversationItem } from '../../services/model';

/**
 * Covers the shared conversation→avatar derivation. The util reads only `type` + the active party's
 * (`peerUser` | `group`) identity/avatar fields, so minimal partial shapes (cast through `unknown`) suffice — no
 * need to construct a full ConversationItem. This is the high-value, low-pain test for the DRY'd logic; the
 * consumers (thread-list, the empty-thread hero) are thin pass-throughs over it.
 */
describe('conversation-avatar util', () => {
  const p2p = {
    type: 'P2P',
    publisherNamespaceId: 0,
    peerUser: {
      account: 'alice',
      avatar: '/uploads/u7.png',
    },
    group: { id: 0, account: '!zero', avatar: '' },
  } as unknown as ConversationItem;
  const group = {
    type: 'GROUP',
    publisherNamespaceId: 7,
    peerUser: { avatar: '' },
    group: {
      id: 12,
      account: '!group-12',
      avatar: '/uploads/g12.png',
    },
  } as unknown as ConversationItem;

  it('sends an authorized demand while the conversation is active', () => {
    const ref = conversationAvatarProfile({
      ...p2p,
      profileRev: 7,
      conversationState: 'ACTIVE',
    });
    expect(avatarProfileDemand(ref)).toEqual({
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'alice', rev: 7 },
    });
  });

  it('falls back to a cache-only lookup for a severed conversation', () => {
    const ref = conversationAvatarProfile({
      ...p2p,
      profileRev: 7,
      conversationState: 'READ_ONLY',
    });
    expect(avatarProfileDemand(ref)).toEqual({
      evidence: null,
      demand: {
        publisherNamespaceId: 0,
        lookup: 'ACCOUNT_PROFILE',
        target: { profileNamespaceId: 0, account: 'alice', rev: 7 },
      },
    });
  });

  it('uses the publisher home namespace but subject namespace zero for foreign peers', () => {
    const ref = conversationAvatarProfile({
      ...p2p,
      publisherNamespaceId: 7,
      account: 'alice',
      profile: {
        name: 'Alice',
        bio: '',
        avatarDigest: null,
      },
      profileRev: 3,
      conversationState: 'READ_ONLY',
    } as ConversationItem);
    const demand = avatarProfileDemand(ref);
    expect(demand && 'demand' in demand ? demand.demand : demand).toEqual({
      publisherNamespaceId: 7,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'alice', rev: 3 },
    });
  });

  it('returns a reference-stable request while the coordinates hold', () => {
    const first = conversationAvatarProfile({
      ...p2p,
      profileRev: 7,
      conversationState: 'ACTIVE',
    });
    const second = conversationAvatarProfile({
      ...p2p,
      profileRev: 7,
      conversationState: 'ACTIVE',
    });
    expect(first).toBe(second);
    // A different conversation form or revision is a different demand object.
    expect(
      conversationAvatarProfile({
        ...p2p,
        profileRev: 7,
        conversationState: 'READ_ONLY',
      }),
    ).not.toBe(first);
    expect(
      conversationAvatarProfile({
        ...p2p,
        profileRev: 8,
        conversationState: 'ACTIVE',
      }),
    ).not.toBe(first);
    // The cache keys the form too: the severed request is stable on its own.
    const severed = conversationAvatarProfile({
      ...p2p,
      profileRev: 7,
      conversationState: 'READ_ONLY',
    });
    expect(
      conversationAvatarProfile({
        ...p2p,
        profileRev: 7,
        conversationState: 'READ_ONLY',
      }),
    ).toBe(severed);
  });

  it('maps P2P → OTHER and GROUP → GROUP', () => {
    expect(conversationAvatarType(p2p)).toBe(UserAvatarType.OTHER);
    expect(conversationAvatarType(group)).toBe(UserAvatarType.GROUP);
  });

  it('derives required identity coordinates without a domain', () => {
    expect(conversationAvatarAccount(p2p)).toBe('alice');
    expect(conversationAvatarNamespaceId(p2p)).toBe(0);
    expect(conversationAvatarAccount(group)).toBe('!group-12');
    expect(conversationAvatarNamespaceId(group)).toBe(7);
  });
});
