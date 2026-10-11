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
import { UserService } from './user.service';
import { apiOrigin } from './runtime';
import { BrowserNotificationAdapter } from './browser-notification.adapter';
import { WebPushService } from './web-push.service';
import { ThreadNavigationIntentService } from './thread-navigation-intent.service';
import type {
  BrowserNotificationBatch,
  NotificationDescriptor,
} from './notification-descriptor.model';

import 'fake-indexeddb/auto';

describe('UnreadAttentionService browser worker bridge', () => {
  const offer = vi.fn();
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
    apiOrigin.set('https://primary');
    offer.mockClear();
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
          provide: UserService,
          useValue: { sessionUserId: signal(11), sessionId: signal(11) },
        },
        { provide: ThreadNavigationIntentService, useValue: { offer } },
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
    apiOrigin.set('');
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
  });

  it('preserves system notifications when the app renderer is destroyed', () => {
    const clear = vi
      .spyOn(BrowserNotificationAdapter.prototype, 'clear')
      .mockResolvedValue();
    TestBed.resetTestingModule();
    expect(clear).not.toHaveBeenCalled();
  });

  it('clears notifications on explicit session invalidation, not again on renderer exit', () => {
    const clear = vi
      .spyOn(BrowserNotificationAdapter.prototype, 'clear')
      .mockResolvedValue();
    TestBed.inject(SessionLifecycleService).invalidateSession();
    expect(clear).toHaveBeenCalledTimes(1);
    TestBed.resetTestingModule();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('submits a notification tap to the shared coordinator rather than opening raw navigation', () => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SOMS_NOTIF_MSG.OPEN, threadId: 42, sessionId: 11 },
      }),
    );
    expect(offer).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'web', threadId: 42, sessionId: 11 }),
    );
    expect(setTopSection).not.toHaveBeenCalled();
    expect(openChat).not.toHaveBeenCalled();
  });

  it('offers exact desktop session scope and rejects unscoped receipts', async () => {
    let pending: unknown = {
      id: 'tap-1',
      threadId: 7,
      sessionId: 11,
      origin: 'https://primary',
    };
    let wake!: () => void;
    const invoke = vi.fn(async (command: string) =>
      command === 'desktop_notification_pending' ? pending : undefined,
    );
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = {
      core: { invoke },
      event: {
        emit: vi.fn(),
        listen: vi.fn(async (_event, handler) => {
          wake = () => handler({ payload: undefined });
          return vi.fn();
        }),
      },
    };
    TestBed.runInInjectionContext(() => new UnreadAttentionService());
    await vi.waitFor(() =>
      expect(offer).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'desktop',
          id: 'tap-1',
          threadId: 7,
          sessionId: 11,
        }),
        expect.any(Number),
      ),
    );
    const intent = offer.mock.calls[0][0];
    expect(invoke).not.toHaveBeenCalledWith(
      'desktop_notification_acknowledge',
      expect.anything(),
    );
    pending = {
      id: 'tap-2',
      threadId: 7,
      sessionId: 12,
      origin: 'https://primary',
    };
    await intent.acknowledge();
    expect(invoke).toHaveBeenCalledWith('desktop_notification_acknowledge', {
      id: 'tap-1',
      threadId: 7,
      sessionId: 11,
      origin: 'https://primary',
    });
    offer.mockClear();
    for (const value of [
      '7',
      { id: 'legacy', threadId: 7 },
      { id: 'bad', threadId: 7, sessionId: 0 },
      {
        id: 'wrong-origin',
        threadId: 7,
        sessionId: 11,
        origin: 'https://other',
      },
    ]) {
      pending = value;
      wake();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(offer).not.toHaveBeenCalled();
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
