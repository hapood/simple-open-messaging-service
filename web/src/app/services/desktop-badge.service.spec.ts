import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { DesktopBadgeService } from './desktop-badge.service';
import { ConversationListService } from './conversation-list.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { UserService } from './user.service';
import { parseLoginSessionId } from './session/session-identity';

// Keep transitive application imports real; only the platform IPC and injected stores are replaced.
describe('desktop Dock badge wake bridge', () => {
  const invoke = vi.fn();
  const items = signal<unknown[]>([]);
  const userId = signal<number | null>(1);
  const login = parseLoginSessionId('11111111-1111-4111-8111-111111111111');

  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke } };
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
    items.set([]);
    userId.set(1);
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ConversationListService, useValue: { items } },
        { provide: UserService, useValue: { sessionUserId: userId } },
      ],
    });
    TestBed.inject(SessionLifecycleService).bindSession(login);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
    vi.restoreAllMocks();
  });

  function start(): void {
    TestBed.inject(DesktopBadgeService);
    TestBed.tick();
  }

  it('wakes Rust with the immutable login, without sending a renderer-computed total', () => {
    start();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('desktop_badge_refresh', {
      sessionUuid: login,
      userId: 1,
    });
    items.set([{ unreadCount: 4 }]);
    TestBed.tick();
    expect(invoke).toHaveBeenCalledTimes(2);
    items.set([{ unreadCount: 0 }]);
    TestBed.tick();
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('does not publish signed-out or invalidated work', () => {
    TestBed.inject(SessionLifecycleService).invalidateSession();
    start();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not refresh for a user whose session has ended', () => {
    start();
    TestBed.inject(SessionLifecycleService).invalidateSession();
    items.set([{ unreadCount: 8 }]);
    TestBed.tick();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('uses the successor login and account on switching', () => {
    start();
    const next = parseLoginSessionId('22222222-2222-4222-8222-222222222222');
    TestBed.inject(SessionLifecycleService).bindSession(next);
    userId.set(2);
    items.set([]);
    TestBed.tick();
    expect(invoke).toHaveBeenLastCalledWith('desktop_badge_refresh', {
      sessionUuid: next,
      userId: 2,
    });
  });

  it('does not introduce a browser or Android badge path', () => {
    delete window.__TAURI_INTERNALS__;
    start();
    expect(invoke).not.toHaveBeenCalled();
    TestBed.resetTestingModule();
    window.__TAURI_INTERNALS__ = {};
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
    start();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stops waking Rust when the renderer service is destroyed', () => {
    start();
    TestBed.resetTestingModule();
    items.set([{ unreadCount: 5 }]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
