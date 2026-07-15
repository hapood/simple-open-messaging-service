import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService, USE_SESSION_TOKEN } from './auth.service';
import { RouteService } from './route.service';
import { PushService } from './push.service';
import { WebPushService } from './web-push.service';
import { UserService } from './user.service';

/**
 * AuthService session/device contract — the client-side half of the device-management feature.
 *
 * Locked down here:
 *  - login() sends the `client` kind (web/desktop/app) + a human-readable `device` label (not the old
 *    opaque device_id uuid), and stores the issued session token in memory;
 *  - revokeSession(id) sends `{ id }` (by row id, not the old jti) and marks the request with the
 *    USE_SESSION_TOKEN context so the interceptor auths it with the session token (isCurrent works);
 *  - getSessions() sets the same context.
 *
 * No AuthInterceptor registered — the request reaches the HttpTestingController backend directly, so the
 * request body + HttpContext are inspected as the service authored them.
 */
describe('AuthService (session/device contract)', () => {
  let svc: AuthService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        AuthService,
        { provide: RouteService, useValue: { redirect: () => {}, openSettings: () => {} } },
        { provide: PushService, useValue: { onLogin: jasmine.createSpy('onLogin'), unregister: jasmine.createSpy('unregister') } },
        { provide: WebPushService, useValue: { onLogin: jasmine.createSpy('onLogin') } },
        { provide: UserService, useValue: { clearSession: jasmine.createSpy('clearSession') } },
      ],
    });
    svc = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });
  afterEach(() => TestBed.resetTestingModule());

  it('login() sends client + a friendly device label, and stores the session token on success', () => {
    expect(svc.sessionToken).toBeNull(); // nothing held before login
    svc.login({ account: 'alice', password: 'pw', isKeep: true }).subscribe();

    const req = httpMock.expectOne((r) => /\/auth\/login$/.test(r.url));
    expect(req.request.body.account).toBe('alice');
    // Headless browser test env → isTauri() false → client 'web'; device is a friendly label (non-empty).
    expect(req.request.body.client).toBe('web');
    expect(typeof req.request.body.device).toBe('string');
    expect(req.request.body.device.length).toBeGreaterThan(0);

    req.flush({
      code: 0,
      message: 'ok',
      data: { access_token: 'at', refresh_token: 'rt', session_token: 'st-1' },
    });
    expect(svc.sessionToken).toBe('st-1');
  });

  it('revokeSession(id) sends { id } (by row id, not jti) and sets the USE_SESSION_TOKEN context', () => {
    svc.revokeSession(42).subscribe();
    const req = httpMock.expectOne((r) => /\/auth\/revoke-session$/.test(r.url));
    expect(req.request.body.id).toBe(42);
    expect(req.request.context.get(USE_SESSION_TOKEN)).toBe(true);
    req.flush({ code: 0, message: 'ok' });
  });

  it('getSessions() sets the USE_SESSION_TOKEN context so isCurrent resolves', () => {
    svc.getSessions().subscribe();
    const req = httpMock.expectOne((r) => /\/auth\/sessions$/.test(r.url));
    expect(req.request.context.get(USE_SESSION_TOKEN)).toBe(true);
    req.flush({ code: 0, message: 'ok', data: [] });
  });
});
