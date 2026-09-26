import 'fake-indexeddb/auto';
import { WebdbStorage } from './webdb-storage';
import { createGroupConversation, createP2PConversation, type ConversationItem } from './model';
import { threadFeedSnapshot } from './thread-feed.test-helper';

describe('resolved thread profile identity', () => {
  const userId = '919201';
  let storage: WebdbStorage;
  beforeEach(async () => {
    storage = new WebdbStorage();
    await storage.openForUser(userId);
  });
  afterEach(async () => storage.closeAndDelete(userId));

  function group(domain = 'local', namespaceId = 0, profileRev = 1, threadId = 91) {
    return createGroupConversation(
      threadId,
      {
        id: threadId,
        account: '!group',
        name: '',
        domain,
        namespaceId,
        profileRev,
      },
      { threadFeedId: 33, visible: true },
    );
  }

  async function seedThread(item: ConversationItem) {
    const subject = item.type === 'GROUP' ? item.group : item.peerUser;
    const feedId = item.threadFeedId ?? 1;
    await storage.mergeThreadStates([threadFeedSnapshot(item.threadId, {
      threadFeedId: feedId,
      type: item.type,
      role: item.role,
      authorityNamespaceId: item.authorityNamespaceId,
      profile: {
        account: subject.account, domain: subject.domain,
        namespaceId: subject.namespaceId, profileRev: item.profileRev,
      },
      threadProfileRev: item.profileRev,
    })]);
    await storage.putThread({ ...item, threadFeedId: feedId });
  }

  it('normalizes a local canonical-domain response before matching and notifying', async () => {
    await seedThread(group());
    const wake = vi.fn();
    storage.profileWake$.subscribe(wake);
    const profile = await storage.commitResolvedProfile({
      account: '!group',
      domain: 'alpha.test',
      namespaceId: 0,
      rev: 1,
      name: 'Created group',
      bio: 'Description',
      avatarBase64: 'YWJj',
    });
    expect(profile.domain).toBe('local');
    expect(profile.avatarDigest).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await (await storage.getProfileAvatarBlob(profile.avatarDigest!))?.text()).toBe('abc');
    expect(wake).toHaveBeenCalledWith({
      event: 'PROFILE_AVAILABLE',
      key: { account: '!group', domain: 'local', namespaceId: 0, rev: 1 },
    });
    expect(await storage.getThreads()).toEqual([
      expect.objectContaining({
        group: expect.objectContaining({
          name: 'Created group',
          description: 'Description',
          avatar: '',
        }),
      }),
    ]);
  });

  it('hydrates local peers while preserving their selected profile revision', async () => {
    await seedThread(
      createP2PConversation(92, {
        account: 'bob',
        domain: 'local',
        namespaceId: 0,
        profileRev: 1,
        name: '',
      }),
    );
    await storage.commitResolvedProfile({
      account: 'bob',
      domain: 'alpha.test',
      namespaceId: 0,
      rev: 1,
      name: 'Bob',
      bio: '',
      avatarBase64: null,
    });
    await storage.commitResolvedProfile({
      account: 'bob',
      domain: 'alpha.test',
      namespaceId: 0,
      rev: 2,
      name: 'Newer unselected name',
      bio: '',
      avatarBase64: null,
    });
    expect(await storage.getThreads()).toEqual([
      expect.objectContaining({
        peerUser: expect.objectContaining({ name: 'Bob' }),
        profileRev: 1,
      }),
    ]);
  });

  it('does not let an in-flight attention write erase a newly resolved title', async () => {
    const stale = group();
    await seedThread(stale);
    await storage.commitResolvedProfile({
      account: '!group',
      domain: 'alpha.test',
      namespaceId: 0,
      rev: 1,
      name: 'Resolved while attention was in flight',
      bio: 'Description',
      avatarBase64: null,
    });
    await storage.advanceThreadRead(91, 1);
    await storage.putThread({ ...stale, lastReadSeq: 1 });
    expect((await storage.getThreads())[0]).toMatchObject({
      lastReadSeq: 1,
      group: {
        name: 'Resolved while attention was in flight',
        description: 'Description',
      },
    });
  });

  it('does not apply a local snapshot to a foreign namespace or another revision', async () => {
    const profile = {
      account: '!group',
      domain: 'alpha.test',
      namespaceId: 0,
      rev: 1,
      name: 'Local group',
      bio: '',
      avatarBase64: null,
    };
    await seedThread(group('bravo.test', 4));
    await storage.commitResolvedProfile(profile);
    expect((await storage.getThreads())[0]).toMatchObject({
      group: { name: '', domain: 'bravo.test' },
    });
    await seedThread(group('local', 0, 2, 92));
    await storage.commitResolvedProfile(profile);
    expect((await storage.getThreads()).find((item) => item.threadId === 92)).toMatchObject({
      group: { name: '' }, profileRev: 2,
    });
  });
});
