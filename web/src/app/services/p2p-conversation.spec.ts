import { createGroupConversation, createP2PConversation } from './model';

const identity = {
  threadId: 7,
  account: 'bob',
  publisherNamespaceId: 4,
  profileRev: 5,
};

describe('conversation construction', () => {
  it('keeps identity and selected revision outside the profile slot', () => {
    const item = createP2PConversation(identity);
    expect(item.account).toBe('bob');
    expect(item.publisherNamespaceId).toBe(4);
    expect(item.profileRev).toBe(5);
    expect(item.profile).toEqual({ name: '', bio: '', avatarDigest: null });
  });

  it('accepts the selected display snapshot as one profile group', () => {
    const profile = { name: 'Bob', bio: 'Hello', avatarDigest: 'avatar-digest' };
    const item = createP2PConversation({ ...identity, profile });
    expect(item.profile).toEqual(profile);
    expect(item.account).toBe(identity.account);
    expect(item.publisherNamespaceId).toBe(identity.publisherNamespaceId);
    expect(item.profileRev).toBe(identity.profileRev);
  });

  it('keeps member count and announcement state inside group meta', () => {
    const item = createGroupConversation({
      ...identity,
      account: '!room',
      profile: { name: 'Room', bio: '', avatarDigest: null },
      meta: {
        memberCount: 3,
        announcementFeedId: '2',
        announcementText: null,
        announcementCreatedAt: 1_000,
        announcementOriginCreatedAt: null,
      },
    });
    expect(item.account).toBe('!room');
    expect(item.meta).toEqual({
      memberCount: 3,
      groupMetaFeedId: '0',
      announcementFeedId: '2',
      announcementText: null,
      announcementCreatedAt: 1_000,
      announcementOriginCreatedAt: null,
      recoveryThrough: null,
      recoveryAnnouncementFeedId: null,
      recoveryAnnouncementText: null,
      recoveryAnnouncementCreatedAt: null,
      recoveryAnnouncementOriginCreatedAt: null,
    });
  });
});
