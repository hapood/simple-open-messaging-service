import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService } from './auth.service';
import { RouteService } from './route.service';
import { PushService } from './push.service';
import { WebPushService } from './web-push.service';
import { UserService } from './user.service';

/**
 * AuthService session-token contract — the single long-lived credential.
 *
 * Locked down here (HttpTestingController backend, no interceptor):
 *  - login() sends the `client` kind (web/desktop/app) + a human-readable `device` label, and stores the
 *    issued session token (in memory + storage), flipping isLoggedIn;
 *  - logout() sends `{ sessionToken }` (no refresh token) and clears the held token;
 *  - revokeSession(id) sends `{ id }` by row id.
 */
describe('AuthService (session-token contract)', () => {
  let svc: AuthService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        AuthService,
        { provide: RouteService, useValue: { redirect: jasmine.createSpy('redirect'), openSettings: () => {} } },
        { provide: PushService, useValue: { onLogin: jasmine.createSpy('onLogin'), unregister: jasmine.createSpy('unregister') } },
        { provide: WebPushService, useValue: { onLogin: jasmine.createSpy('onLogin'), unregister: jasmine.createSpy('unregister') } },
        { provide: UserService, useValue: { clearSession: jasmine.createSpy('clearSession') } },
      ],
    });
    svc = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('login() sends client + a friendly device label, and stores the session token on success', () => {
    expect(svc.sessionToken).toBeNull(); // nothing held before login
    svc.login({ account: 'alice', password: 'pw', isKeep: false }).subscribe();

    const req = httpMock.expectOne((r) => /\/auth\/login$/.test(r.url));
    expect(req.request.body.account).toBe('alice');
    // Headless browser test env → isTauri() false → client 'web'; device is a friendly label (non-empty).
    expect(req.request.body.client).toBe('web');
    expect(typeof req.request.body.device).toBe('string');
    expect(req.request.body.device.length).toBeGreaterThan(0);

    req.flush({ code: 0, message: 'ok', data: { session_token: 'st-1' } });
    expect(svc.sessionToken).toBe('st-1');
    expect(svc.isLoggedIn()).toBe(true);
  });

  it('logout() sends { sessionToken } (no refresh token) and clears the held token', () => {
    // Log in first so a session token is held.
    svc.login({ account: 'alice', password: 'pw', isKeep: false }).subscribe();
    httpMock
      .expectOne((r) => /\/auth\/login$/.test(r.url))
      .flush({ code: 0, message: 'ok', data: { session_token: 'st-1' } });

    svc.logout().subscribe();
    const req = httpMock.expectOne((r) => /\/auth\/logout$/.test(r.url));
    expect(req.request.body.sessionToken).toBe('st-1');
    expect(req.request.body.refreshToken).toBeUndefined();
    req.flush({ code: 0, message: 'ok' });

    expect(svc.sessionToken).toBeNull();
    expect(svc.isLoggedIn()).toBe(false);
  });

  it('revokeSession(id) sends { id } (by row id, not jti)', () => {
    svc.revokeSession(42).subscribe();
    const req = httpMock.expectOne((r) => /\/auth\/revoke-session$/.test(r.url));
    expect(req.request.body.id).toBe(42);
    req.flush({ code: 0, message: 'ok' });
  });
});
