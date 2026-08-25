import {
  conversationAvatarType,
  conversationAvatarIdentityId,
  conversationAvatarAccount,
  conversationAvatarDomain,
  conversationAvatarSrc,
} from './conversation-avatar.util';
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
    peerUser: {
      id: 7,
      account: 'alice',
      domain: 'local',
      isForeigner: false,
      avatar: '/uploads/u7.png',
    },
    group: { id: 0, account: '!zero', avatar: '' },
  } as unknown as ConversationItem;
  const group = {
    type: 'GROUP',
    peerUser: { id: 0, avatar: '' },
    group: { id: 12, account: '!group-12', avatar: '/uploads/g12.png' },
  } as unknown as ConversationItem;

  it('maps P2P → OTHER and GROUP → GROUP', () => {
    expect(conversationAvatarType(p2p)).toBe(UserAvatarType.OTHER);
    expect(conversationAvatarType(group)).toBe(UserAvatarType.GROUP);
  });

  it('derives the identity id from the active party (P2P peer / group)', () => {
    expect(conversationAvatarIdentityId(p2p)).toBe(7);
    expect(conversationAvatarIdentityId(group)).toBe(12);
  });

  it('derives the avatar src from the active party', () => {
    expect(conversationAvatarSrc(p2p)).toBe('/uploads/u7.png');
    expect(conversationAvatarSrc(group)).toBe('/uploads/g12.png');
  });

  it('derives the stable account and home domain used by the avatar', () => {
    expect(conversationAvatarAccount(p2p)).toBe('alice');
    expect(conversationAvatarDomain(p2p)).toBeUndefined();
    expect(conversationAvatarAccount(group)).toBe('!group-12');
    expect(conversationAvatarDomain(group)).toBeUndefined();
  });
});
