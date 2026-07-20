import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { HttpBackend, HttpErrorResponse, HttpRequest, HttpHeaders, provideHttpClient, withFetch } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { TauriHttpBackend } from './tauri-http.backend';

/**
 * TauriHttpBackend DI wiring — regression guard for the NG0201 that occurred because `TauriHttpBackend`
 * does `inject(FetchBackend)` in a field initializer, but `FetchBackend` is only registered on its own
 * token by the `withFetch()` feature of `provideHttpClient`. Without `withFetch()` the token is unbound
 * and the very first HTTP request (which constructs the backend) throws NG0201 at
 * `<instance_members_initializer>`. app.config.ts must therefore always pair
 * `provideHttpClient(withFetch(), …)` with the `{ provide: HttpBackend, useClass: TauriHttpBackend }`
 * override (last provider wins, so TauriHttpBackend stays the chain terminus while FetchBackend remains
 * the resolvable delegate).
 */
describe('TauriHttpBackend DI wiring (regression: NG0201 without withFetch)', () => {
  it('constructs when HttpBackend is overridden on top of withFetch() (FetchBackend resolves)', () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withFetch()),
        { provide: HttpBackend, useClass: TauriHttpBackend },
      ],
    });
    const backend = TestBed.inject(HttpBackend);
    expect(backend).toBeInstanceOf(TauriHttpBackend);
  });

  it('throws NG0201 when withFetch() is omitted — the FetchBackend token is unbound otherwise', () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        // Deliberately NO withFetch(): the base provideHttpClient() provides HttpXhrBackend only and
        // leaves the FetchBackend token unbound, so TauriHttpBackend's inject(FetchBackend) fails.
        provideHttpClient(),
        { provide: HttpBackend, useClass: TauriHttpBackend },
      ],
    });
    expect(() => TestBed.inject(HttpBackend)).toThrowError(/NG0201/i);
  });
});

/**
 * Content-type synthesis for the webview→Rust `api_request` IPC. Regression guard for the HTTP 415 that
 * broke EVERY `/api/v1` POST/PUT/PATCH under the Tauri shell (desktop + Android): `serializeBody` produced
 * JSON bytes but NO content-type, no caller or interceptor set one, and reqwest does NOT auto-set a
 * Content-Type for a raw byte body — so Fastify rejected the body with 415 Unsupported Media Type. The fix
 * mirrors Angular's `HttpRequest.detectContentTypeHeader()` (which the stock `FetchBackend` applies, and
 * which is why the browser path worked): synthesize `application/json` for object bodies. These tests stub
 * the Tauri bridge via the SAME `window` globals `isTauri`/`tauriInvoke` read (`__TAURI_INTERNALS__` +
 * `window.__TAURI__.core.invoke`) so they exercise the real `TauriHttpBackend` end-to-end without an SDK.
 */
describe('TauriHttpBackend content-type synthesis under Tauri (regression: 415 on JSON POSTs)', () => {
  // A narrowed view of the `window` globals `isTauri`/`tauriInvoke` read (declared on Window only via an
  // index signature, hence dot access is forbidden — go through this typed cast instead).
  type TauriWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
  };
  const tauriWindow = (): TauriWindow => window as unknown as TauriWindow;

  // The webview→Rust `api_request` args captured by the fake invoke bridge.
  let invokeArgs: { cmd: string; args: { headers?: Record<string, string>; body?: unknown } } | undefined;

  beforeEach(() => {
    invokeArgs = undefined;
    // `isTauri()` keys off `__TAURI_INTERNALS__`; `tauriInvoke()` off `window.__TAURI__.core.invoke`.
    tauriWindow().__TAURI_INTERNALS__ = {};
    tauriWindow().__TAURI__ = {
      core: {
        invoke: async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
          invokeArgs = { cmd, args: args as { headers?: Record<string, string>; body?: unknown } };
          // A successful 200 JSON response — the body shape `api_request` returns to JS.
          return { status: 200, headers: {}, body: '{"code":0,"message":"success","data":{}}' };
        },
      },
    };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withFetch()),
        { provide: HttpBackend, useClass: TauriHttpBackend },
      ],
    });
  });

  afterEach(() => {
    tauriWindow().__TAURI_INTERNALS__ = undefined;
    tauriWindow().__TAURI__ = undefined;
  });

  it('forwards Content-Type: application/json for a JSON object body (otherwise reqwest POSTs with no media type → 415)', async () => {
    const backend = TestBed.inject(HttpBackend);
    await firstValueFrom(backend.handle(new HttpRequest('POST', '/api/v1/auth/qr/create', { client: 'app' })));
    expect(invokeArgs!.cmd).toBe('api_request');
    // The body crossed the IPC as raw JSON bytes...
    expect(invokeArgs!.args.body).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(invokeArgs!.args.body as Uint8Array))).toEqual({ client: 'app' });
    // ...AND carried a synthesized Content-Type the Fastify JSON parser accepts.
    expect(invokeArgs!.args.headers).toEqual(jasmine.objectContaining({ 'content-type': 'application/json' }));
  });

  it('does not override a Content-Type the caller set explicitly (mirrors Angular respecting an existing header)', async () => {
    const backend = TestBed.inject(HttpBackend);
    const req = new HttpRequest('POST', '/api/v1/x', { a: 1 }, {
      headers: new HttpHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
    });
    await firstValueFrom(backend.handle(req));
    expect(invokeArgs!.args.headers?.['content-type']).toBe('application/json; charset=utf-8');
  });

  it('forwards a Blob body\'s own type as Content-Type (mirrors Angular detectContentTypeHeader → blob.type)', async () => {
    const backend = TestBed.inject(HttpBackend);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await firstValueFrom(backend.handle(new HttpRequest('POST', '/api/v1/x', blob)));
    expect(invokeArgs!.args.headers?.['content-type']).toBe('image/png');
  });

  it('does not synthesize a Content-Type for an untyped Blob (Angular returns blob.type || null)', async () => {
    const backend = TestBed.inject(HttpBackend);
    const blob = new Blob([new Uint8Array([1, 2, 3])]); // no type
    await firstValueFrom(backend.handle(new HttpRequest('POST', '/api/v1/x', blob)));
    expect(invokeArgs!.args.headers?.['content-type']).toBeUndefined();
  });

  it('surfaces a non-2xx backend response as an HttpErrorResponse carrying the status', async () => {
    tauriWindow().__TAURI__ = {
      core: { invoke: async () => ({ status: 415, headers: { 'content-type': 'application/json' }, body: '{"code":1,"message":"Unsupported Media Type"}' }) },
    };
    const backend = TestBed.inject(HttpBackend);
    const err = await firstValueFrom(backend.handle(new HttpRequest('POST', '/api/v1/auth/qr/create', { client: 'app' }))).catch((e: unknown) => e as HttpErrorResponse);
    expect(err instanceof HttpErrorResponse).toBe(true);
    expect((err as HttpErrorResponse).status).toBe(415);
  });
});
