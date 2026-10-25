import { createGroupConversation, createP2PConversation } from './model';
import {
  avatarProfileDemand,
  conversationAvatarProfile,
  groupMemberAvatarProfile,
} from './avatar-profile-ref';

const group = (account: string) => createGroupConversation(7, {
  id: 7, account, name: 'Team', namespaceId: 4,
}, { conversationState: 'ACTIVE' });
const member = { account: 'alice', namespaceId: 0, profileRev: 3 };

describe('group member profile references', () => {
  it('preserves the group publisher, member namespace and selected revision', () => {
    const thread = group('!team');
    const ref = groupMemberAvatarProfile(thread, member);
    expect(avatarProfileDemand(ref)).toEqual({
      publisherNamespaceId: 4,
      lookup: 'GROUP_MEMBER_PROFILE',
      groupAccount: '!team',
      target: { account: 'alice', profileNamespaceId: 0, rev: 3 },
    });
    expect(groupMemberAvatarProfile(thread, member)).toBe(ref);
  });

  it('does not reuse a home profile ref for a group member at the same coordinates', () => {
    const home = conversationAvatarProfile(createP2PConversation(8, {
      account: 'alice', namespaceId: 4, profileRev: 3,
    }));
    const roster = groupMemberAvatarProfile(group('!team'), member);
    expect(roster).not.toBe(home);
    expect(roster?.groupAccount).toBe('!team');
  });

  it('does not reuse group authorization across groups', () => {
    const first = groupMemberAvatarProfile(group('!first'), member);
    const second = groupMemberAvatarProfile(group('!second'), member);
    expect(first).not.toBe(second);
    expect(second?.groupAccount).toBe('!second');
  });

  it('retains the reference but disables network authority after departure', () => {
    const ref = groupMemberAvatarProfile({
      ...group('!team'), conversationState: 'READ_ONLY',
    }, member);
    expect(ref?.linked).toBe(false);
    expect(groupMemberAvatarProfile(group('!team'), { ...member, profileRev: 0 }))
      .toBeUndefined();
  });
});
