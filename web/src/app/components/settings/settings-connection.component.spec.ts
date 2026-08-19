import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  provideZonelessChangeDetection,
  signal,
  WritableSignal,
} from '@angular/core';
import {
  HttpErrorResponse,
  provideHttpClient,
  withXhr,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TimeoutError } from 'rxjs';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import {
  InlineTranslocoLoader,
  translations,
} from '../../i18n/transloco.loader';
import {
  classifyProbeError,
  SettingsConnectionComponent,
} from './settings-connection.component';
import {
  WebsocketService,
  ConnectionState,
} from '../../services/websocket.service';
import { LanguageService } from '../../services/language.service';
import { apiPrefix } from '../../services/constants';

/**
 * SettingsConnectionComponent unit tests — the two diagnostics rows' class logic.
 *
 * Locked down here:
 *  - the realtime-state → (pill class, canRetry gate, label) mapping across all four
 *    {@link ConnectionState}s (the connKey routing + the retry gate, which is the real logic —
 *    `retryNow` is a no-op when open/closed);
 *  - the health-result → (pill class, label, hint) mapping;
 *  - `check()`'s outcomes — healthy 200, non-ok HTTP, a connection-level failure, and a probe that
 *    blows past the deadline — plus the omitted-version → "" fallback, the re-entrancy guard, and that
 *    `checking` always clears in the `finally`. The probe goes through HttpClient →
 *    HttpTestingController, matching the component's runtime backend (TauriHttpBackend under Tauri /
 *    the fetch backend in the browser); a raw fetch of an API path would miss the (removed) `api://`
 *    proxy on Android.
 *
 * Translation comes from the real {@link InlineTranslocoLoader} (synchronous), so the label
 * assertions pin the connKey/health routing against the checked-in `en.json`. Template is blanked
 * (the unit is the class logic, matching peer-profile.spec) — no DOM queries, no Material render.
 */
describe('SettingsConnectionComponent', () => {
  let comp: SettingsConnectionComponent;
  // The realtime connection state — driven from the test to move the SSE-state signal.
  let state: WritableSignal<ConnectionState>;
  let retryNow: Mock;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    state = signal<ConnectionState>('closed');
    retryNow = vi.fn().mockName('retryNow');

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        provideTransloco({
          config: {
            availableLangs: [
              { id: 'en', label: 'English' },
              { id: 'zh-CN', label: '简体中文' },
            ],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        SettingsConnectionComponent,
        {
          provide: WebsocketService,
          useValue: { state, retryNow } as unknown as WebsocketService,
        },
        {
          provide: LanguageService,
          useValue: { lang: signal('en') } as unknown as LanguageService,
        },
      ],
    }).overrideComponent(SettingsConnectionComponent, {
      set: { template: '' },
    });
    comp = TestBed.createComponent(
      SettingsConnectionComponent,
    ).componentInstance;
    httpMock = TestBed.inject(HttpTestingController);
    // Prime the `en` dictionary synchronously. The inline loader emits via an Observable; Transloco
    // may not have cached it by the time these synchronous label assertions read it (the computeds
    // read lazily), so setTranslation + setActiveLang force the cache now. Without this, translate()
    // returns the raw key and the label-asserting tests see e.g. 'settings.connStatusOpen'.
    const transloco = TestBed.inject(TranslocoService);
    transloco.setTranslation(translations['en'], 'en');
    transloco.setActiveLang('en');
  });
  afterEach(() => {
    httpMock.verify();
    TestBed.resetTestingModule();
  });

  // ── Realtime connection mapping ────────────────────────────────────────────────────────────

  // [state, pillClass, canRetry, label] — verifies connKey routing + the retry gate at once.
  const STATE_CASES: ReadonlyArray<[ConnectionState, string, boolean, string]> =
    [
      ['open', 'active', false, 'Connected'],
      ['connecting', 'warn', true, 'Connecting'],
      ['reconnecting', 'warn', true, 'Reconnecting'],
      ['closed', '', false, 'Disconnected'],
    ];
  for (const [s, pillClass, canRetry, label] of STATE_CASES) {
    it(`maps realtime state '${s}' → pill '${pillClass}', canRetry=${canRetry}, label='${label}'`, () => {
      state.set(s);
      expect(comp.connPillClass()).toBe(pillClass);
      expect(comp.canRetry()).toBe(canRetry);
      expect(comp.connLabel()).toBe(label);
    });
  }

  it('retry() forwards to websocket.retryNow (the no-op gating lives in the service, not here)', () => {
    state.set('reconnecting');
    comp.retry();
    expect(retryNow).toHaveBeenCalledTimes(1);
  });

  // ── Server-health mapping ─────────────────────────────────────────────────────────────────

  it('health pill + hint are idle before any probe (muted class, "Not checked", default desc)', () => {
    expect(comp.healthPillClass()).toBe('');
    expect(comp.healthPillLabel()).toBe('Not checked');
    expect(comp.healthHint()).toBe(
      "Probe the server's liveness endpoint (no sign-in needed).",
    );
  });

  it('health pill shows OK (active) after a healthy result and Failed (error) after a failed one', () => {
    comp.health.set({ ok: true, version: '1', ms: 5 });
    expect(comp.healthPillClass()).toBe('active');
    expect(comp.healthPillLabel()).toBe('OK');
    comp.health.set({ ok: false, error: 'down' });
    expect(comp.healthPillClass()).toBe('error');
    expect(comp.healthPillLabel()).toBe('Failed');
  });

  it('health hint surfaces version+latency when ok, the error when not', () => {
    comp.health.set({ ok: true, version: '1.2.3', ms: 42 });
    expect(comp.healthHint()).toContain('Reachable');
    expect(comp.healthHint()).toContain('1.2.3');
    expect(comp.healthHint()).toContain('42');
    comp.health.set({ ok: false, error: 'HTTP 503' });
    expect(comp.healthHint()).toContain('Unreachable');
    expect(comp.healthHint()).toContain('HTTP 503');
  });

  // ── check() probe ─────────────────────────────────────────────────────────────────────────

  it('check() records ok + version + latency on a healthy 200 and hits the public health URL', async () => {
    const p = comp.check();
    const req = httpMock.expectOne(`${apiPrefix()}/health`);
    expect(req.request.method).toBe('GET');
    req.flush({ data: { version: '1.2.3' } });
    await p;
    const h = comp.health()!;
    expect(h.ok).toBe(true);
    expect(h.version).toBe('1.2.3');
    expect(typeof h.ms).toBe('number');
    expect(h.ms as number).toBeGreaterThanOrEqual(0);
    expect(comp.checking()).toBe(false);
  });

  it('check() falls back to an empty version when the payload omits data.version', async () => {
    const p = comp.check();
    httpMock.expectOne(`${apiPrefix()}/health`).flush({ data: {} });
    await p;
    expect(comp.health()?.version).toBe('');
  });

  it('check() records an HTTP error status when the response is not ok', async () => {
    const p = comp.check();
    httpMock
      .expectOne(`${apiPrefix()}/health`)
      .flush({}, { status: 503, statusText: 'Service Unavailable' });
    await p;
    // Non-2xx surfaces as an HttpErrorResponse; the catch maps it to "HTTP <status>" (HttpErrorResponse
    // implements Error but does not extend it, so the catch handles it explicitly — see the component).
    expect(comp.health()).toEqual({ ok: false, error: 'HTTP 503' });
    expect(comp.checking()).toBe(false);
  });

  it('check() records "network" for a connection-level failure (status 0) and clears checking', async () => {
    const p = comp.check();
    httpMock
      .expectOne(`${apiPrefix()}/health`)
      .error(new ErrorEvent('error', { message: 'boom' }));
    await p;
    // An ErrorEvent flush yields an HttpErrorResponse with status 0 → mapped to "network".
    expect(comp.health()).toEqual({ ok: false, error: 'network' });
    expect(comp.checking()).toBe(false);
  });

  // ── classifyProbeError (pure) ─────────────────────────────────────────────────────────────
  // The classifier extracted from check()'s catch, tested directly — no HttpClient pipe, hence no
  // zoneless stability stall. This is also the only way to reach the TimeoutError branch: HttpClient's
  // testing backend can't synthesize one, and driving the real `timeout(ms)` timer is slow/flaky here.
  // [err, label, expected].
  const PROBE_ERROR_CASES: ReadonlyArray<[unknown, string, string]> = [
    [
      new HttpErrorResponse({ status: 503 }),
      'HttpErrorResponse 503',
      'HTTP 503',
    ],
    [
      new HttpErrorResponse({ status: 0 }),
      'HttpErrorResponse status 0',
      'network',
    ],
    [new TimeoutError(), 'TimeoutError', 'timeout'],
    [new Error('boom'), 'Error', 'boom'],
    ['a bare string', 'non-Error', 'network'],
  ];
  for (const [err, label, expected] of PROBE_ERROR_CASES) {
    it(`classifyProbeError maps ${label} → '${expected}'`, () => {
      expect(classifyProbeError(err)).toBe(expected);
    });
  }

  it('check() is re-entrancy-guarded: a second call while one is in flight is a no-op (one request)', async () => {
    const first = comp.check();
    expect(comp.checking()).toBe(true);
    await comp.check(); // guard short-circuits — must not issue a second GET
    const req = httpMock.expectOne(`${apiPrefix()}/health`); // exactly one outstanding request
    expect(httpMock.match(`${apiPrefix()}/health`).length).toBe(0); // no second request queued
    req.flush({ data: { version: '9.9.9' } });
    await first;
    expect(comp.health()?.ok).toBe(true);
    expect(comp.health()?.version).toBe('9.9.9');
    expect(comp.checking()).toBe(false);
  });
});
