import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { UnreadAttentionService } from './unread-attention.service';
import { ConversationListService } from './conversation-list.service';
import { NotificationFeedService } from './notification-feed.service';
import { NotificationPrefsService } from './notification-prefs.service';
import { NavStateMachineService } from './nav-state.service';
import { SOMS_NOTIF_MSG } from './sw-notif-protocol';
import { WebsocketService } from './websocket.service';

/**
 * The foreground away-attention facade. Covers the NEW wiring added for SW-driven per-card dismiss +
 * body-tap deep-link: the SW→page `message` channel ({@link UnreadAttentionService.onSwMessage}) routes a
 * `dismiss` to the per-thread HWM store + an `open` to navigation, and `pullAndRender` forwards the
 * `threadHwms` map on the away fetch. The platform adapters + live SW click flow are covered elsewhere
 * (browser-notification.adapter.spec / manual).
 */
describe('UnreadAttentionService (SW message routing + threadHwms wiring)', () => {
  let svc: UnreadAttentionService;
  let threadSeq: Subject<{ threadId: number; seq: number }>;
  let recordThreadDismiss: Mock;
  let openChat: Mock;
  let fetchAway: Mock;

  /** Dispatch a message as if the push SW postMessaged the page (the ctor registered the listener). */
  function swMessage(data: unknown, ports: MessagePort[] = []): void {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data, ports }),
    );
  }

  beforeEach(() => {
    threadSeq = new Subject();
    recordThreadDismiss = vi.fn().mockName('recordThreadDismiss');
    openChat = vi.fn().mockName('openChat');
    fetchAway = vi
      .fn()
      .mockName('fetchAwayNotifications')
      .mockResolvedValue({ notifications: [], stateFeedEndId: 11 });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        UnreadAttentionService,
        {
          provide: ConversationListService,
          useValue: {
            items: signal([]).asReadonly(),
            threadSeq$: threadSeq.asObservable(),
            stateFeedCursor: () => 10,
            threadHwms: () => ({ 7: 3 }),
            recordThreadDismiss,
            clearThreadDismiss: vi.fn().mockName('clearThreadDismiss'),
          },
        },
        {
          provide: NotificationFeedService,
          useValue: { query: fetchAway },
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
        { provide: WebsocketService, useValue: { state: signal('open') } },
      ],
    });
    svc = TestBed.inject(UnreadAttentionService);
  });

  it('routes a soms-notif-dismiss to recordThreadDismiss', () => {
    swMessage({ type: SOMS_NOTIF_MSG.DISMISS, threadId: 7, seq: 9 });
    expect(recordThreadDismiss).toHaveBeenCalledWith({ threadId: 7, seq: 9 });
  });

  it('ignores a dismiss with missing/invalid fields (no HWM write)', () => {
    swMessage({ type: SOMS_NOTIF_MSG.DISMISS, threadId: 7 }); // no seq
    swMessage({ type: SOMS_NOTIF_MSG.DISMISS, seq: 9 }); // no threadId
    swMessage({ type: SOMS_NOTIF_MSG.DISMISS, threadId: 'x', seq: 9 }); // non-number threadId
    expect(recordThreadDismiss).not.toHaveBeenCalled();
  });

  it('routes a soms-notif-open to NavStateMachineService.openChat', () => {
    swMessage({ type: SOMS_NOTIF_MSG.OPEN, threadId: 42 });
    expect(openChat).toHaveBeenCalledWith(42);
  });

  it('claims Push notification aggregation while this page has healthy SSE', () => {
    const postMessage = vi.fn();
    swMessage({ type: SOMS_NOTIF_MSG.CLAIM }, [
      { postMessage } as unknown as MessagePort,
    ]);
    expect(postMessage).toHaveBeenCalledWith({ claimed: true });
  });

  it('ignores an unknown message type (forward-compat)', () => {
    swMessage({ type: 'soms-something-new', threadId: 7 });
    swMessage({}); // no type at all
    expect(recordThreadDismiss).not.toHaveBeenCalled();
    expect(openChat).not.toHaveBeenCalled();
  });

  it('forwards the threadHwms map on the away fetch (per-thread dismiss respected server-side)', async () => {
    // Away = window unfocused. A committed content head then arms the debounced pull + render.
    window.dispatchEvent(new Event('blur'));
    threadSeq.next({ threadId: 7, seq: 11 });
    await new Promise((r) => setTimeout(r, 350)); // past the 300ms debounce
    expect(fetchAway).toHaveBeenCalledTimes(1);
    expect(fetchAway).toHaveBeenCalledWith(10, 'message', { 7: 3 });
  });

  it('elects one browser tab before projecting an SSE notification', async () => {
    const originalLocks = navigator.locks;
    const request = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => Promise<void>,
      ) =>
        callback({ name: 'soms-notification-projection', mode: 'exclusive' }),
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });
    try {
      window.dispatchEvent(new Event('blur'));
      threadSeq.next({ threadId: 7, seq: 12 });
      await new Promise((r) => setTimeout(r, 350));
      expect(request).toHaveBeenCalledWith(
        'soms-notification-projection',
        { ifAvailable: true },
        expect.any(Function),
      );
      expect(fetchAway).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
    }
  });

  it('does not project when another browser tab owns the notification lock', async () => {
    const originalLocks = navigator.locks;
    const request = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => Promise<void>,
      ) => callback(null),
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });
    try {
      window.dispatchEvent(new Event('blur'));
      threadSeq.next({ threadId: 7, seq: 13 });
      await new Promise((r) => setTimeout(r, 350));
      expect(request).toHaveBeenCalledOnce();
      expect(fetchAway).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: originalLocks,
      });
    }
  });
});
