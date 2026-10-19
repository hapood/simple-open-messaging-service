import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ConversationListService } from './conversation-list.service';
import { NavStateMachineService } from './nav-state.service';
import { UserService } from './user.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { apiOrigin } from './runtime';
import { ThreadNavigationIntentService } from './thread-navigation-intent.service';

describe('ThreadNavigationIntentService session readiness and fencing', () => {
  const sessionId = signal<number | null>(null);
  const navigationReady = signal(false);
  const items = signal([{ threadId: 7 }]);
  const navigationRevision = signal(0);
  const openExternalChat = vi.fn(() => true);
  const acknowledge = vi.fn();
  let service: ThreadNavigationIntentService;
  let lifecycle: SessionLifecycleService;
  const offer = (id = 'tap') => service.offer({ source: 'android', id, threadId: 7, sessionId: 11, acknowledge });
  beforeEach(() => {
    apiOrigin.set('https://primary');
    sessionId.set(null); navigationReady.set(false); items.set([{ threadId: 7 }]); navigationRevision.set(0);
    openExternalChat.mockClear(); acknowledge.mockClear();
    TestBed.configureTestingModule({ providers: [
      provideZonelessChangeDetection(),
      { provide: UserService, useValue: { sessionId } },
      { provide: ConversationListService, useValue: { navigationReady, items } },
      { provide: NavStateMachineService, useValue: { openExternalChat, navigationRevision } },
    ] });
    service = TestBed.inject(ThreadNavigationIntentService);
    lifecycle = TestBed.inject(SessionLifecycleService);
  });
  afterEach(() => { TestBed.resetTestingModule(); apiOrigin.set(''); });
  it('reacts to HELLO and hydration without another wake', () => {
    offer(); TestBed.tick(); sessionId.set(11); TestBed.tick();
    expect(openExternalChat).not.toHaveBeenCalled();
    navigationReady.set(true); TestBed.tick();
    expect(openExternalChat).toHaveBeenCalledExactlyOnceWith(7);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
  it('waits for the projected target', () => {
    sessionId.set(11); navigationReady.set(true); items.set([]); offer(); TestBed.tick();
    expect(acknowledge).not.toHaveBeenCalled();
    items.set([{ threadId: 7 }]); TestBed.tick();
    expect(openExternalChat).toHaveBeenCalledExactlyOnceWith(7);
  });
  it('does not override newer manual navigation', () => {
    offer(); TestBed.tick(); navigationRevision.set(1); TestBed.tick();
    sessionId.set(11); navigationReady.set(true); TestBed.tick();
    expect(openExternalChat).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it('rejects async reads crossing invalidation', () => {
    const scope = lifecycle.capture(); lifecycle.invalidateSession();
    sessionId.set(11); navigationReady.set(true);
    service.offer({ source: 'desktop', id: 'late', threadId: 7, sessionId: 11, acknowledge }, scope);
    TestBed.tick(); expect(openExternalChat).not.toHaveBeenCalled();
  });
  it('does not replay pre-HELLO taps after logout', () => {
    offer(); lifecycle.invalidateSession(); sessionId.set(11); navigationReady.set(true); TestBed.tick();
    expect(openExternalChat).not.toHaveBeenCalled();
  });
  it('retires a tap when the configured primary origin changes during hydration', () => {
    offer(); TestBed.tick(); apiOrigin.set('https://other');
    sessionId.set(11); navigationReady.set(true); TestBed.tick();
    expect(openExternalChat).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled();
  });
  it('rejects another session on the same account', () => {
    offer(); sessionId.set(12); navigationReady.set(true); TestBed.tick();
    expect(openExternalChat).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled();
  });
});
