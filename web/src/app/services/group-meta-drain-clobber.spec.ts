import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { SessionLifecycleService } from './session-lifecycle.service';
import { provideZonelessChangeDetection } from '@angular/core';
import { threadFeedSnapshot } from './thread-feed.test-helper';
import { createGroupConversation } from './model';
import {
  STATE_FEED_WORKER_FACTORY,
  WebdbService,
  provideWebdbService,
} from './webdb.service';

/**
 * Reproduction for docs/development/browser-e2e-bug-group-meta-not-materialized.md:
 * the renderer's fire-and-forget `putThread` write-through (projectThread /
 * applyThreadFeedOrder / applyGroupProjectionHeads) carries the in-memory
 * ConversationItem, whose GROUP presentation columns (groupMetaFeedId,
 * memberCount, subjectName) are never refreshed after a Group Meta drain
 * commits in the database worker. If any such persist lands after the drain's
 * atomic page commit, the drained cursor and roster count regress to their
 * pre-drain defaults while the `members` store keeps the applied roster —
 * exactly the IDB dump recorded in the bug report.
 */
describe('group-meta drain vs renderer write-through (bug repro)', () => {
  let webdb: WebdbService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideWebdbService(),
        { provide: STATE_FEED_WORKER_FACTORY, useValue: () => null },
      ],
    });
    webdb = TestBed.inject(WebdbService);
  });

  afterEach(async () => {
    try {
      await webdb.closeAndDelete('1');
    } catch {
      /* already closed */
    }
  });

  it('a stale putThread after applyGroupMetaPage regresses cursor, member count and subject', async () => {
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
        groupMetaFeedEndId: '3',
      }),
    ]);

    // 2) Renderer materializes the thread list item and persists it. The group
    //    profile has not resolved yet, so presentation starts at defaults.
    const inMemory = createGroupConversation(
      15,
      {
        id: 15,
        account: '!four-one-alpha',
        name: '',
        namespaceId: 0,
        profileRev: 1,
      },
      { threadFeedId: 2 },
    );
    await webdb.putThread(inMemory);

    // 3) The database worker drains the Group Meta page (creator OWNER upsert).
    await webdb.applyGroupMetaPage({
      threadId: 15,
      namespaceId: 0,
      page: {
        account: '!four-one-alpha',
        mode: 'full',
        items: [
          {
            feedId: '2',
            operation: 'GROUP_PROFILE',
            body: { profileNamespaceId: 0, profileRev: 1 },
          },
          {
            feedId: '3',
            operation: 'MEMBER_UPSERT',
            account: 'alice.w1007',
            domain: 'local',
            namespaceId: 0,
            body: { role: 'OWNER', profileRev: 1 },
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
      group: { memberCount: 1, groupMetaFeedId: '3' },
    });
    expect(
      await webdb.queryGroupMembers({ threadId: 15, take: 20 }),
    ).toHaveLength(1);

    // 4) Any later renderer persist writes the still-stale in-memory item
    //    (unread projection, feed order, roster head, mute/pin, ...).
    await webdb.putThread({ ...inMemory });

    const after = (await webdb.getThreads()).find(
      (item) => item.threadId === 15,
    );
    // The regression the browser lab observed: cursor and member count are
    // back at their pre-drain defaults while the roster row survives.
    expect(after).toMatchObject({
      group: { memberCount: 0, groupMetaFeedId: '0', name: '' },
    });
    expect(
      await webdb.queryGroupMembers({ threadId: 15, take: 20 }),
    ).toHaveLength(1);
  });
});
