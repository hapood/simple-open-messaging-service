import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { Subject, of } from 'rxjs';
import { UnreadAttentionService } from './unread-attention.service';
import { ConversationListService } from './conversation-list.service';
import { NotificationPrefsService } from './notification-prefs.service';
import { NavStateMachineService } from './nav-state.service';
import { SOMS_NOTIF_MSG } from './sw-notif-protocol';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbService } from './webdb.service';
import { ProfileNamespaceRepository } from './profile-namespace-store.service';
import { WebPushService } from './web-push.service';
import type {
  BrowserNotificationBatch,
  NotificationDescriptor,
} from './notification-descriptor.model';

import 'fake-indexeddb/auto';

describe('UnreadAttentionService browser worker bridge', () => {
  const openChat = vi.fn();
  const setTopSection = vi.fn();
  const postMessage = vi.fn();
  const worker = vi.fn().mockResolvedValue({ active: { postMessage } });
  const refreshBackgroundThreadFeed = vi.fn().mockResolvedValue(undefined);
  const chatThreadId = signal<number | undefined>(undefined);
  const topSection = signal('chats');
  let browserNotifications: Subject<BrowserNotificationBatch>;
  let updates: Subject<unknown[]>;

  beforeEach(() => {
    openChat.mockClear();
    setTopSection.mockClear();
    postMessage.mockClear();
    worker.mockClear();
    chatThreadId.set(undefined);
    topSection.set('chats');
    browserNotifications = new Subject();
    updates = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        UnreadAttentionService,
        {
          provide: WebdbService,
          useValue: { browserNotifications$: browserNotifications },
        },
        {
          provide: ProfileNamespaceRepository,
          useValue: { resolve: () => of({ domain: 'chat.example.test' }) },
        },
        { provide: WebPushService, useValue: { worker } },
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
        {
          provide: NavStateMachineService,
          useValue: { openChat, setTopSection, chatThreadId, topSection },
        },
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

  it('routes a notification tap to the existing chat shell', () => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SOMS_NOTIF_MSG.OPEN, threadId: 42 },
      }),
    );
    expect(setTopSection).toHaveBeenCalledWith('chats');
    expect(openChat).toHaveBeenCalledWith(42);
  });

  it('answers the worker with the active chat', async () => {
    chatThreadId.set(7);
    const channel = new MessageChannel();
    const reply = vi.fn();
    channel.port1.onmessage = (event) => reply(event.data);
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SOMS_NOTIF_MSG.ACTIVE_CHAT_REQUEST },
        ports: [channel.port2],
      }),
    );
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ threadId: 7 }));
    channel.port1.close();
    channel.port2.close();
  });

  it('relays worker-projected notifications without building them on the main thread', async () => {
    const descriptor = {
      tag: 'soms-thread-7',
      data: { threadId: 7 },
      count: 2,
    } as NotificationDescriptor;
    browserNotifications.next({
      userId: 11,
      entries: [{ feedId: 9, descriptor }],
    });
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: SOMS_NOTIF_MSG.PRESENT,
        userId: 11,
        entries: [{ feedId: 9, descriptor }],
      }),
    );
    updates.next([]);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('does not relay a completed worker registration after session invalidation', async () => {
    let resolve!: (value: {
      active: { postMessage: typeof postMessage };
    }) => void;
    worker.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    browserNotifications.next({ userId: 11, entries: [] });
    TestBed.inject(SessionLifecycleService).invalidateSession();
    resolve({ active: { postMessage } });
    await new Promise((done) => setTimeout(done, 0));
    expect(postMessage).not.toHaveBeenCalled();
  });
});
