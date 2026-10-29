import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  provideHttpClientTesting,
  HttpTestingController,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { inject } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { AuthInterceptor } from '../auth.interceptor';
import {
  HTTP_RETRY_CONFIG,
  httpResilienceInterceptor,
} from '../http-resilience.interceptor';
import { REQUEST_SCOPE, RequestScope } from '../request-context';
import { AuthService } from './auth.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { ToastService } from './toast.service';
import { Observable, of } from 'rxjs';
import { ConfigService } from './config.service';

describe('ConfigService HTTP ownership', () => {
  let service: ConfigService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(
          withInterceptors([
            (req, next) =>
              inject(AuthInterceptor).intercept(req, { handle: next }),
            httpResilienceInterceptor,
          ]),
        ),
        provideHttpClientTesting(),
        AuthInterceptor,
        { provide: AuthService, useValue: { redoLoginAuth: vi.fn() } },
        { provide: HTTP_RETRY_CONFIG, useValue: { maxRetries: 0 } },
        { provide: ToastService, useValue: { warn: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    });
    service = TestBed.inject(ConfigService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('shares a server-scoped load and updates consumers across authentication transitions', async () => {
    const first = service.ensureLoaded();
    expect(service.ensureLoaded()).toBe(first);
    expect(service.methodsForPlatform()).toEqual([]);
    const request = http.expectOne('/api/v1/config');
    expect(request.request.context.get(REQUEST_SCOPE)).toBe(
      RequestScope.Server,
    );
    TestBed.inject(SessionLifecycleService).invalidateSession();
    request.flush({
      code: 0,
      data: {
        registrationOpen: false,
        loginMethods: [
          { key: 'qr', disabled: false },
          { key: 'otp', disabled: false },
        ],
        defaultLoginMethod: 'otp',
      },
    });
    await first;
    expect(service.loaded()).toBe(true);
    expect(service.methodsForPlatform()).toEqual(['qr', 'otp']);
    expect(service.defaultLoginMethod()).toBe('otp');
  });

  it('preserves advertised order, drops junk, and falls back when the default is disabled', async () => {
    const load = service.ensureLoaded();
    http
      .expectOne('/api/v1/config')
      .flush({
        code: 0,
        data: {
          registrationOpen: false,
          loginMethods: [
            { key: 'password', disabled: true },
            { key: 'bogus', disabled: false },
            { key: 'qr', disabled: false },
            { key: 'qr', disabled: true }, // duplicate: first occurrence wins
          ],
          defaultLoginMethod: 'password', // disabled → fallback to first enabled
        },
      });
    await load;
    expect(service.loginMethods()).toEqual([
      { key: 'password', disabled: true },
      { key: 'qr', disabled: false },
    ]);
    expect(service.defaultLoginMethod()).toBe('qr');
    expect(service.methodsForPlatform()).toEqual(['qr']);
  });

  it('treats a policy with zero enabled methods as a config failure', async () => {
    const load = service.ensureLoaded();
    http.expectOne('/api/v1/config').flush({
      code: 0,
      data: {
        registrationOpen: false,
        loginMethods: [
          { key: 'password', disabled: true },
          { key: 'otp', disabled: true },
          { key: 'qr', disabled: true },
        ],
        defaultLoginMethod: 'qr',
      },
    });
    await load;
    expect(service.loaded()).toBe(true);
    expect(service.loginMethods()).toBeNull();
    expect(service.defaultLoginMethod()).toBeNull();
  });

  it('cancels an obsolete server load and publishes only the replacement', async () => {
    const oldLoad = service.ensureLoaded();
    const oldRequest = http.expectOne('/api/v1/config');
    const newLoad = service.reload();
    expect(oldRequest.cancelled).toBe(true);
    const newRequest = http.expectOne('/api/v1/config');
    await oldLoad;
    expect(service.loaded()).toBe(false);
    expect(service.loginMethods()).toBeNull();
    newRequest.flush({
      code: 0,
      data: {
        registrationOpen: true,
        loginMethods: [{ key: 'password', disabled: false }],
        defaultLoginMethod: 'password',
      },
    });
    await newLoad;
    expect(service.loaded()).toBe(true);
    expect(service.methodsForPlatform()).toEqual(['password']);
  });
});

describe('ConfigService connection cancellation', () => {
  it('unsubscribes the active config request and waits for an explicit retry', async () => {
    let requestCancelled = false;
    const pending = new Observable(() => () => {
      requestCancelled = true;
    });
    const http = {
      get: vi
        .fn()
        .mockName('get')
        .mockReturnValueOnce(pending)
        .mockReturnValueOnce(
          of({
            code: 0,
            message: 'ok',
            data: {
              registrationOpen: true,
              loginMethods: [
                { key: 'password', disabled: false },
                { key: 'otp', disabled: false },
                { key: 'qr', disabled: false },
              ],
              defaultLoginMethod: 'qr',
            },
          }),
        ),
    } as Pick<HttpClient, 'get'>;
    const service = new ConfigService(http as HttpClient);

    const abandoned = service.ensureLoaded();

    service.cancelLoad();
    await abandoned;

    expect(requestCancelled).toBe(true);
    expect(service.loaded()).toBe(true);
    expect(service.cancelled()).toBe(true);
    expect(service.loginMethods()).toBeNull();

    await service.ensureLoaded();
    expect(http.get).toHaveBeenCalledTimes(1);

    await service.reload();

    expect(http.get).toHaveBeenCalledTimes(2);
    expect(service.cancelled()).toBe(false);
    expect(service.loginMethods()).toEqual([
      { key: 'password', disabled: false },
      { key: 'otp', disabled: false },
      { key: 'qr', disabled: false },
    ]);
    expect(service.defaultLoginMethod()).toBe('qr');
  });
});
