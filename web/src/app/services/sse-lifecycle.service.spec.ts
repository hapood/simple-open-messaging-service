import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { PushRegistrationService } from './push-registration.service';
import { SseLifecycleService } from './sse-lifecycle.service';
import { WebsocketService } from './websocket.service';
import { ThreadRepository } from './thread-store.service';
import { BROWSER_SESSION } from './browser-session.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { createSessionCacheDescriptor } from './session/session-identity';
import { apiOrigin } from './runtime';

describe('SseLifecycleService application orchestration', () => {
  const originalOrigin = apiOrigin();
  let auth: {
    loggedIn: ReturnType<typeof signal<boolean>>;
    isLoggedIn: () => boolean;
    redoLoginAuth: ReturnType<typeof vi.fn>;
    restoreSession: ReturnType<typeof vi.fn>;
  };
  let ws: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    forcedLogout$: Subject<string | undefined>;
    eventSubject: Subject<any>;
  };
  let onEvent: ReturnType<typeof vi.fn>;
  let browserOwner: { currentSession: ReturnType<typeof createSessionCacheDescriptor> | null; bindIdentity: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    const loggedIn = signal(false);
    auth = {
      loggedIn,
      isLoggedIn: () => loggedIn(),
      redoLoginAuth: vi.fn(),
      restoreSession: vi.fn(async () => {}),
    };
    ws = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      forcedLogout$: new Subject(),
      eventSubject: new Subject(),
    };
    onEvent = vi.fn();
    browserOwner = { currentSession: null, bindIdentity: vi.fn().mockResolvedValue(undefined) };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: BROWSER_SESSION, useValue: browserOwner },
        { provide: AuthService, useValue: auth },
        { provide: ThreadRepository, useValue: {} },
        { provide: WebsocketService, useValue: ws },
        { provide: PushRegistrationService, useValue: { onEvent } },
      ],
    });
    TestBed.inject(SseLifecycleService);
    TestBed.tick();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    apiOrigin.set(originalOrigin);
  });

  it('owns login/logout and origin changes without starting a logged-out stream', () => {
    expect(ws.connect).not.toHaveBeenCalled();
    apiOrigin.set('http://localhost:4101');
    TestBed.tick();
    expect(ws.connect).not.toHaveBeenCalled();
    auth.loggedIn.set(true);
    TestBed.tick();
    expect(ws.connect).toHaveBeenCalledOnce();
    ws.disconnect.mockClear();
    apiOrigin.set('http://localhost:4102');
    TestBed.tick();
    expect(ws.disconnect).toHaveBeenCalledOnce();
    expect(ws.connect).toHaveBeenCalledTimes(2);
    auth.loggedIn.set(false);
    TestBed.tick();
    expect(ws.disconnect).toHaveBeenCalledTimes(2);
  });

  it('subscribes before restoration and forwards revocation reasons and HELLO to their owners', async () => {
    const session = createSessionCacheDescriptor();
    browserOwner.currentSession = session;
    TestBed.inject(SessionLifecycleService).bindSession(session.id);
    auth.restoreSession.mockImplementation(async () => {
      ws.eventSubject.next({ event: 'HELLO', data: { userId: 42, sessionId: 11 } });
      ws.forcedLogout$.next('device_revoke');
    });
    await TestBed.inject(SseLifecycleService).restoreSession();
    expect(browserOwner.bindIdentity).toHaveBeenCalledWith({ userId: 42, serverSessionId: 11 });
    expect(onEvent).toHaveBeenCalledWith('HELLO', { userId: 42, sessionId: 11 });
    expect(auth.redoLoginAuth).toHaveBeenCalledWith('device_revoke');
    TestBed.resetTestingModule();
    ws.forcedLogout$.next('late');
    ws.eventSubject.next({ event: 'HELLO' });
    expect(auth.redoLoginAuth).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it('removes the browser foreground listener on teardown', () => {
    document.dispatchEvent(new Event('visibilitychange'));
    expect(ws.connect).toHaveBeenCalledOnce();
    TestBed.resetTestingModule();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(ws.connect).toHaveBeenCalledOnce();
  });
});
