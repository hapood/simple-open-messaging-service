import { WebdbStorage } from './webdb-storage';
import { prepareTestSessionCache } from './session/session-cache.test-helper';
import { SessionLifecycleService } from './session-lifecycle.service';
import {
  createGroupConversation,
  createP2PConversation,
  type ConversationItem,
} from './model';
import { threadFeedSnapshot } from './thread-feed.test-helper';

describe('resolved thread profile identity', () => {
  const userId = '919201';
  let storage: WebdbStorage;
  beforeEach(async () => {
    storage = new WebdbStorage(() => null, new SessionLifecycleService());
    storage.bindSessionCache(await prepareTestSessionCache());
    await storage.openForUser(userId);
  });
  afterEach(async () => storage.closeAndDelete(userId));

  function group(namespaceId = 0, profileRev = 1, threadId = 91) {
    return createGroupConversation({
      threadId,
      account: '!group',
      publisherNamespaceId: namespaceId,
      threadFeedId: 33,
      visible: true,
      profileRev,
    });
  }

  async function seedThread(item: ConversationItem) {
    const feedId = item.threadFeedId ?? 1;
    await storage.mergeThreadStates([
      threadFeedSnapshot(item.threadId, {
        threadFeedId: feedId,
        type: item.type,
        role: item.role,
        publisherNamespaceId: item.publisherNamespaceId,
        profileAccount: item.account,
        profileRev: item.profileRev,
      }),
    ]);
  }

  it('normalizes a local canonical-domain response before matching and notifying', async () => {
    await seedThread(group());
    const wake = vi.fn();
    storage.profileWake$.subscribe(wake);
    const profile = await storage.commitResolvedProfile({
      account: '!group',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      rev: 1,
      name: 'Created group',
      bio: 'Description',
      avatarBase64: 'YWJj',
    });
    expect(profile.avatarDigest).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      await (await storage.getProfileAvatarBlob(profile.avatarDigest!))?.text(),
    ).toBe('abc');
    expect(wake).toHaveBeenCalledWith({
      event: 'PROFILE_AVAILABLE',
      key: {
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        account: '!group',
        rev: 1,
      },
    });
    const restored = await storage.getThreads();
    expect(restored[0].profile).not.toHaveProperty('domain');
    expect(restored).toEqual([
      expect.objectContaining({
        profile: expect.objectContaining({
          name: 'Created group',
          bio: 'Description',
        }),
      }),
    ]);
  });

  it('hydrates local peers while preserving their selected profile revision', async () => {
    await seedThread(
      createP2PConversation({
        threadId: 92,
        account: 'bob',
        publisherNamespaceId: 0,
        profileRev: 1,
      }),
    );
    await storage.commitResolvedProfile({
      account: 'bob',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      rev: 1,
      name: 'Bob',
      bio: '',
      avatarBase64: null,
    });
    await storage.commitResolvedProfile({
      account: 'bob',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      rev: 2,
      name: 'Newer unselected name',
      bio: '',
      avatarBase64: null,
    });
    expect(await storage.getThreads()).toEqual([
      expect.objectContaining({
        profile: expect.objectContaining({ name: 'Bob' }),
        profileRev: 1,
      }),
    ]);
  });

  it('preserves resolved profile content when advancing attention reads', async () => {
    await seedThread(group());
    await storage.commitResolvedProfile({
      account: '!group',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      rev: 1,
      name: 'Resolved while attention was in flight',
      bio: 'Description',
      avatarBase64: null,
    });
    await storage.advanceThreadRead(91, 1);
    expect((await storage.getThreads())[0]).toMatchObject({
      lastReadSeq: 1,
      profile: {
        name: 'Resolved while attention was in flight',
        bio: 'Description',
      },
    });
  });

  it('does not apply a local snapshot to a foreign namespace or another revision', async () => {
    const profile = {
      account: '!group',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      rev: 1,
      name: 'Local group',
      bio: '',
      avatarBase64: null,
    };
    await seedThread(group(4));
    await storage.commitResolvedProfile(profile);
    expect((await storage.getThreads())[0]).toMatchObject({
      profile: { name: '!group' },
    });
    await seedThread(group(0, 2, 92));
    await storage.commitResolvedProfile(profile);
    expect(
      (await storage.getThreads()).find((item) => item.threadId === 92),
    ).toMatchObject({
      profile: { name: '!group' },
      profileRev: 2,
    });
  });
});
