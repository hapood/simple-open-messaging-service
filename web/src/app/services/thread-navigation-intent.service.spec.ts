import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ConversationListService } from './conversation-list.service';
import { NavStateMachineService } from './nav-state.service';
import { UserService } from './user.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { apiOrigin } from './runtime';
import { ThreadNavigationIntentService } from './thread-navigation-intent.service';
import { RouteService } from './route.service';
import { Router } from '@angular/router';
import { LayoutService } from './layout.service';
import type { ConversationItem } from './model';

describe('notification navigation with real navigation and route services', () => {
  const ready = signal(false);
  const acknowledge = vi.fn();
  let nav: NavStateMachineService;
  let route: RouteService;
  let service: ThreadNavigationIntentService;
  beforeEach(() => {
    history.replaceState(null, '', '/');
    ready.set(false);
    acknowledge.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: Router, useValue: {} },
        { provide: LayoutService, useValue: { mode: signal('compact') } },
        {
          provide: UserService,
          useValue: { sessionId: signal(11), sessionUserId: signal(1) },
        },
        {
          provide: ConversationListService,
          useValue: {
            navigationReady: ready,
            items: signal([{ threadId: 7 }]),
          },
        },
      ],
    });
    nav = TestBed.inject(NavStateMachineService);
    route = TestBed.inject(RouteService);
    service = TestBed.inject(ThreadNavigationIntentService);
    nav.openChat(7);
    TestBed.tick();
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    history.replaceState(null, '', '/');
  });

  it.each([
    'settings',
    'profile',
    'friends',
    'aside',
    'child',
    'group',
    'back',
    'search',
  ])('retires waiting taps on manual %s', (entry) => {
    service.offer({
      source: 'android',
      id: 'waiting',
      threadId: 7,
      acknowledge,
    });
    TestBed.tick();
    switch (entry) {
      case 'settings':
        route.openSettings();
        break;
      case 'profile':
        route.openProfile();
        break;
      case 'friends':
        route.openFriendRequests('add');
        break;
      case 'aside':
        nav.openAside('group-info');
        break;
      case 'child':
        nav.pushAside('group-members');
        break;
      case 'group':
        nav.openGroupJoinRequests({
          threadId: 7,
          type: 'GROUP',
          role: 'ADMIN',
        } as ConversationItem);
        break;
      case 'back':
        nav.back();
        break;
      case 'search':
        nav.openSearch();
        break;
    }
    const revision = nav.navigationRevision();
    ready.set(true);
    TestBed.tick();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(nav.navigationRevision()).toBe(revision);
  });

  it('does not override manual navigation while a friend dialog import is pending', async () => {
    ready.set(true);
    service.offer({
      source: 'android',
      id: 'friend',
      target: { kind: 'friend-requests' },
      acknowledge,
    });
    TestBed.tick();
    route.openProfile();
    const pane = nav.paneStack()[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
    TestBed.tick();
    expect(nav.paneStack()).toEqual([pane]);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('lets synchronous cancel callbacks supersede notification navigation without acknowledging it', () => {
    nav.pushPane({
      kind: 'dialog',
      onResult: () => route.openFriendRequests('add'),
    });
    service.offer({
      source: 'android',
      id: 'reentrant',
      threadId: 7,
      acknowledge,
    });
    ready.set(true);
    TestBed.tick();
    expect(nav.chatThreadId()).toBeUndefined();
    expect(nav.paneStack()).toHaveLength(1);
    expect(nav.paneStack()[0].inputs).toEqual({ initialTab: 'add' });
    expect(acknowledge).not.toHaveBeenCalled();
    TestBed.tick();
    expect(nav.paneStack()).toHaveLength(1);
  });
});

describe('ThreadNavigationIntentService session readiness and fencing', () => {
  const sessionId = signal<number | null>(null);
  const navigationReady = signal(false);
  const items = signal<{ threadId: number; type?: string; role?: string }[]>([
    { threadId: 7 },
  ]);
  const navigationRevision = signal(0);
  const openExternalChat = vi.fn(() => true);
  const acknowledge = vi.fn();
  const returnToThreadList = vi.fn(() => {
    navigationRevision.update((v) => v + 1);
    return true;
  });
  const openAside = vi.fn();
  const popupDlg = vi.fn();
  let service: ThreadNavigationIntentService;
  let lifecycle: SessionLifecycleService;
  const offer = (id = 'tap') =>
    service.offer({ source: 'android', id, threadId: 7, acknowledge });
  beforeEach(() => {
    apiOrigin.set('https://primary');
    sessionId.set(null);
    navigationReady.set(false);
    items.set([{ threadId: 7 }]);
    navigationRevision.set(0);
    openExternalChat.mockClear();
    acknowledge.mockClear();
    returnToThreadList.mockClear();
    openAside.mockClear();
    popupDlg.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: { sessionId } },
        {
          provide: ConversationListService,
          useValue: { navigationReady, items },
        },
        {
          provide: NavStateMachineService,
          useValue: {
            openExternalChat,
            navigationRevision,
            returnToThreadList,
            openGroupJoinRequests: openAside,
          },
        },
        {
          provide: RouteService,
          useFactory: () => {
            // Model the dialog graph reaching notification services again. Lazy
            // resolution must happen after this service has finished construction.
            TestBed.inject(ThreadNavigationIntentService);
            return { openFriendRequests: popupDlg };
          },
        },
      ],
    });
    service = TestBed.inject(ThreadNavigationIntentService);
    lifecycle = TestBed.inject(SessionLifecycleService);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    apiOrigin.set('');
  });
  it('uses the shared group entry with Applications and acknowledges before deferred mount', () => {
    sessionId.set(11);
    navigationReady.set(true);
    items.set([{ threadId: 7, type: 'GROUP', role: 'ADMIN' }]);
    openExternalChat.mockImplementationOnce(() => {
      navigationRevision.update((v) => v + 2);
      return true;
    });
    service.offer({
      source: 'android',
      id: 'group',
      target: { kind: 'group-join-requests', threadId: 7 },
      acknowledge,
    });
    TestBed.tick();
    expect(openExternalChat).toHaveBeenCalledExactlyOnceWith(7);
    expect(openAside).toHaveBeenCalledExactlyOnceWith(
      items()[0],
      'applications',
    );
    expect(acknowledge).toHaveBeenCalledOnce();
    TestBed.tick();
    expect(openAside).toHaveBeenCalledOnce();
  });
  it('uses the shared friend entry after Home with no conversation rows', async () => {
    sessionId.set(11);
    navigationReady.set(true);
    items.set([]);
    service.offer({
      source: 'web',
      sessionId: 11,
      id: 'friend',
      target: { kind: 'friend-requests' },
      acknowledge,
    });
    TestBed.tick();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(popupDlg).toHaveBeenCalledExactlyOnceWith('pending');
    });
    expect(returnToThreadList).toHaveBeenCalledOnce();
    expect(returnToThreadList.mock.invocationCallOrder[0]).toBeLessThan(
      popupDlg.mock.invocationCallOrder[0],
    );
    expect(openExternalChat).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledOnce();
  });
  it('does not instantiate the dialog dependency graph during construction', () => {
    expect(popupDlg).not.toHaveBeenCalled();
    expect(returnToThreadList).not.toHaveBeenCalled();
  });
  it('reacts to HELLO and hydration without another wake', () => {
    offer();
    TestBed.tick();
    sessionId.set(11);
    TestBed.tick();
    expect(openExternalChat).not.toHaveBeenCalled();
    navigationReady.set(true);
    TestBed.tick();
    expect(openExternalChat).toHaveBeenCalledExactlyOnceWith(7);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
  it('waits for the projected target', () => {
    sessionId.set(11);
    navigationReady.set(true);
    items.set([]);
    offer();
    TestBed.tick();
    expect(acknowledge).not.toHaveBeenCalled();
    items.set([{ threadId: 7 }]);
    TestBed.tick();
    expect(openExternalChat).toHaveBeenCalledExactlyOnceWith(7);
  });
  it('does not override newer manual navigation', () => {
    offer();
    TestBed.tick();
    navigationRevision.set(1);
    TestBed.tick();
    sessionId.set(11);
    navigationReady.set(true);
    TestBed.tick();
    expect(openExternalChat).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it('rejects async reads crossing invalidation', () => {
    const scope = lifecycle.capture();
    lifecycle.invalidateSession();
    sessionId.set(11);
    navigationReady.set(true);
    service.offer(
      { source: 'desktop', id: 'late', threadId: 7, acknowledge },
      scope,
    );
    TestBed.tick();
    expect(openExternalChat).not.toHaveBeenCalled();
  });
  it('does not replay pre-HELLO taps after logout', () => {
    offer();
    lifecycle.invalidateSession();
    sessionId.set(11);
    navigationReady.set(true);
    TestBed.tick();
    expect(openExternalChat).not.toHaveBeenCalled();
  });
  it('retires a tap when the configured primary origin changes during hydration', () => {
    offer();
    TestBed.tick();
    apiOrigin.set('https://other');
    sessionId.set(11);
    navigationReady.set(true);
    TestBed.tick();
    expect(openExternalChat).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it('rejects another session on the same account', () => {
    service.offer({
      source: 'web',
      id: 'tap',
      threadId: 7,
      sessionId: 11,
      acknowledge,
    });
    sessionId.set(12);
    navigationReady.set(true);
    TestBed.tick();
    expect(openExternalChat).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
