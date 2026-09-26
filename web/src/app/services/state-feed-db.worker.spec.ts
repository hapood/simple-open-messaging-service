import 'fake-indexeddb/auto';
import { WebdbStorage } from './webdb-storage';
import { threadStructure } from './thread-feed.test-helper';

it('reports Group Meta changes from an explicit drain even when the thread cursor is already consumed', async () => {
  const storage = new WebdbStorage();
  await storage.openForUser('9517');
  await storage.mergeThreadStates(
    [
      {
        ...threadStructure(9, {
          type: 'GROUP',
          profile: { account: '!team', domain: 'local', namespaceId: 0, profileRev: 1 },
        }),
        threadId: 9,
        threadFeedId: 1,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        alias: null,
        threadProfileRev: 1,
        groupMetaFeedEndId: '3',
        joinRequestEndFeedId: 0,
        joinRequestReadFeedId: -1,
        groupInviteEndFeedId: 0,
        announcementReadFeedId: 0,
        lastReadSeq: 0,
        unreadCount: 0,
        lastMentionSeq: null,
        previews: [],
      },
    ],
    1,
  );
  await storage.commitResolvedProfile({
    account: '!team', domain: 'local', namespaceId: 0, rev: 1,
    name: 'Team', bio: '', avatarBase64: null,
  });
  let handler!: (event: { data: unknown }) => void;
  const post = vi.fn();
  vi.stubGlobal('postMessage', post);
  vi.stubGlobal(
    'addEventListener',
    (_type: string, callback: typeof handler) => {
      handler = callback;
    },
  );
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          account: '!team',
          mode: 'full',
          items: [],
          scannedThrough: '3',
          groupMetaFeedEndId: '3',
          hasMore: false,
        },
      }),
    ),
  );
  try {
    await import('./state-feed-db.worker');
    handler({
      data: {
        id: 1,
        type: 'thread-sync',
        userId: '9517',
        target: 1,
        after: 1,
        url: '/thread-feed',
        groupMetaUrl: '/user/group-meta',
        profileResolutionUrl: '/user/profile-resolution',
      },
    });
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith({
        id: 1,
        ok: true,
        result: { cursor: 1, states: [], groupThreadIds: [9] },
      }),
    );
  } finally {
    await storage.closeAndDelete('9517');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
