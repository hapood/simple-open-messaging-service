import { TestBed } from '@angular/core/testing';
import { SessionLifecycleService } from './session-lifecycle.service';
import { prepareTestSessionCache } from './session/session-cache.test-helper';
import { provideZonelessChangeDetection } from '@angular/core';
import { threadFeedSnapshot } from './thread-feed.test-helper';
import {
  STATE_FEED_WORKER_FACTORY,
  WebdbService,
  provideWebdbService,
} from './webdb.service';

describe('group-meta drain vs renderer local patches', () => {
  let webdb: WebdbService;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideWebdbService(),
        { provide: STATE_FEED_WORKER_FACTORY, useValue: () => null },
      ],
    });
    webdb = TestBed.inject(WebdbService);
    const session = await prepareTestSessionCache();
    TestBed.inject(SessionLifecycleService).bindSession(session.id);
    webdb.bindSessionCache(session);
  });

  afterEach(async () => {
    try {
      await webdb.closeAndDelete('1');
    } catch {
      /* already closed */
    }
  });

  it('preserves committed Meta progress when a stale renderer changes mute', async () => {
    await webdb.openForUser('1');

    // 1) Server truth arrives: creator's thread-feed snapshot with a meta target.
    await webdb.mergeThreadStates([
      threadFeedSnapshot(15, {
        type: 'GROUP',
        threadFeedId: 2,
        role: 'OWNER',
        profileAccount: '!four-one-alpha',
        publisherNamespaceId: 0,
        profileRev: 1,
      }),
    ]);

    // Capture renderer state before the worker commits its Meta page.
    const inMemory = (await webdb.getThreads())[0];

    // 3) The database worker drains the Group Meta page (the group's count).
    await webdb.applyGroupMetaPage({
      threadId: 15,
      namespaceId: 0,
      page: {
        account: '!four-one-alpha',
        items: [
          {
            feedId: 3,
            createdAt: 1_100,
            originCreatedAt: null,
            operation: 'GROUP_MEMBER_COUNT',
            body: { memberCount: 1 },
          },
        ],
        hasMore: false,
        scannedThrough: '3',
        groupMetaFeedEndId: '3',
      },
    });

    const drained = (await webdb.getThreads()).find(
      (item) => item.threadId === 15,
    );
    expect(drained).toMatchObject({
      type: 'GROUP',
      meta: { memberCount: 1, groupMetaFeedId: '3' },
    });

    // The local operation writes only its owned field, not the stale read model.
    await webdb.patchThread(inMemory.threadId, { muted: !inMemory.muted });

    const after = (await webdb.getThreads()).find(
      (item) => item.threadId === 15,
    );
    expect(after).toMatchObject({
      muted: true,
      profile: { name: '!four-one-alpha' },
      meta: { memberCount: 1, groupMetaFeedId: '3' },
    });
  });
});
