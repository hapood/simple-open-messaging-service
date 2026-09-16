import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { UnreadAttentionService } from './unread-attention.service';
import { ConversationListService } from './conversation-list.service';
import { NotificationPrefsService } from './notification-prefs.service';
import { NavStateMachineService } from './nav-state.service';
import { SOMS_NOTIF_MSG } from './sw-notif-protocol';
import { SessionLifecycleService } from './session-lifecycle.service';
import { BrowserNotificationAdapter } from './browser-notification.adapter';
import { createP2PConversation } from './model';
import type { ThreadNotificationUpdate } from './thread-notification';
import { WebdbService } from './webdb.service';

import 'fake-indexeddb/auto';
import {
  resetNotificationSince,
  readNotificationSince,
  advanceNotificationSince,
} from './browser-notification-checkpoint';

describe('UnreadAttentionService committed thread notifications', () => {
  let updates: Subject<ThreadNotificationUpdate[]>;
  const openChat = vi.fn();
  const refreshBackgroundThreadFeed = vi.fn().mockResolvedValue(undefined);
  let show: ReturnType<typeof vi.spyOn>;
  const update = (feed = 1, count = 3): ThreadNotificationUpdate => ({
    item: createP2PConversation(
      7,
      { id: 2, account: 'peer', name: 'Peer' },
      { unreadCount: count, lastReadSeq: 2 },
    ),
    state: {
      threadId: 7,
      threadFeedId: feed,
      messageEndSeq: 5,
      tombstoneEndSeq: 0,
      groupMetaFeedEndId: null,
      lastReadSeq: 1,
      unreadCount: 4,
      lastMentionSeq: null,
      previews: [
        {
          seq: 5,
          createdAt: '2026-09-09T00:00:00Z',
          sender: { account: 'peer', domain: 'test' },
          status: 'LIVE',
          text: 'Hello',
        },
      ],
    },
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 350));

  beforeEach(async () => {
    await resetNotificationSince();
    openChat.mockClear();
    updates = new Subject();
    show = vi
      .spyOn(BrowserNotificationAdapter.prototype, 'showDescriptor')
      .mockResolvedValue();
    vi.spyOn(BrowserNotificationAdapter.prototype, 'clear').mockResolvedValue();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        UnreadAttentionService,
        {
          provide: WebdbService,
          useValue: { getAvatar: vi.fn().mockResolvedValue(undefined) },
        },
        {
          provide: ConversationListService,
          useValue: {
            items: signal([]),
            threadNotifications$: updates,
            refreshBackgroundThreadFeed,
          },
        },
        {
          provide: NotificationPrefsService,
          useValue: {
            enabled: () => true,
            previewMode: () => 'message',
            sound: () => true,
          },
        },
        { provide: NavStateMachineService, useValue: { openChat } },
        {
          provide: TranslocoService,
          useValue: {
            getActiveLang: () => 'en',
            translate: (key: string) => key,
          },
        },
      ],
    });
    TestBed.inject(UnreadAttentionService);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('routes notification taps', () => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SOMS_NOTIF_MSG.OPEN, threadId: 42 },
      }),
    );
    expect(openChat).toHaveBeenCalledWith(42);
  });
  it('refreshes committed database state only for a complete background wake', () => {
    refreshBackgroundThreadFeed.mockClear();
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SOMS_NOTIF_MSG.COMMITTED, userId: 7 },
      }),
    );
    expect(refreshBackgroundThreadFeed).not.toHaveBeenCalled();
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SOMS_NOTIF_MSG.COMMITTED, userId: 7, cursor: 0 },
      }),
    );
    expect(refreshBackgroundThreadFeed).toHaveBeenCalledWith(7);
  });
  it('uses the reconciled count and coalesces the latest update without HTTP', async () => {
    window.dispatchEvent(new Event('blur'));
    updates.next([update(1, 3)]);
    updates.next([update(2, 2)]);
    await flush();
    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.calls[0][0]).toMatchObject({
      count: 2,
      body: 'Hello',
      data: { threadId: 7 },
    });
    expect(await readNotificationSince()).toBe(2);
  });
  it('does not replay a foreground update after blur', async () => {
    updates.next([update()]);
    window.dispatchEvent(new Event('blur'));
    await flush();
    expect(show).not.toHaveBeenCalled();
    expect(await readNotificationSince()).toBe(1);
  });
  it('does not replay pending updates after focus and blur', async () => {
    window.dispatchEvent(new Event('blur'));
    updates.next([update()]);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));
    await flush();
    expect(show).not.toHaveBeenCalled();
  });
  it('drops pending work at account invalidation', async () => {
    window.dispatchEvent(new Event('blur'));
    updates.next([update()]);
    TestBed.inject(SessionLifecycleService).invalidateSession();
    await flush();
    expect(show).not.toHaveBeenCalled();
    expect(await readNotificationSince()).toBe(0);
  });
  it('does not display a feed update already presented by another tab', async () => {
    await advanceNotificationSince(5);
    window.dispatchEvent(new Event('blur'));
    updates.next([update(4)]);
    await flush();
    expect(show).not.toHaveBeenCalled();
  });
  it('passes a zero count to close the existing browser card', async () => {
    window.dispatchEvent(new Event('blur'));
    updates.next([update(2, 0)]);
    await flush();
    expect(show.mock.calls[0][0].count).toBe(0);
  });
});
