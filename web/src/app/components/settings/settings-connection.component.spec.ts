import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal, WritableSignal } from '@angular/core';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { InlineTranslocoLoader, translations } from '../../i18n/transloco.loader';
import { SettingsConnectionComponent } from './settings-connection.component';
import { WebsocketService, ConnectionState } from '../../services/websocket.service';
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
 *  - `check()`'s three branches — healthy 200, non-ok HTTP, and a thrown/rejected network error —
 *    plus the non-Error → generic "network" fallback, the omitted-version → "" fallback, the
 *    re-entrancy guard, and that `checking` always clears in the `finally`.
 *
 * Translation comes from the real {@link InlineTranslocoLoader} (synchronous), so the label
 * assertions pin the connKey/health routing against the checked-in `en.json`. Template is blanked
 * (the unit is the class logic, matching peer-profile.spec) — no DOM queries, no Material render.
 */
describe('SettingsConnectionComponent', () => {
  let comp: SettingsConnectionComponent;
  // The realtime connection state — driven from the test to move the SSE-state signal.
  let state: WritableSignal<ConnectionState>;
  let retryNow: jasmine.Spy;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.resetTestingModule();
    state = signal<ConnectionState>('closed');
    retryNow = jasmine.createSpy('retryNow');

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: {
            availableLangs: [{ id: 'en', label: 'English' }, { id: 'zh-CN', label: '简体中文' }],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        SettingsConnectionComponent,
        { provide: WebsocketService, useValue: { state, retryNow } as unknown as WebsocketService },
        { provide: LanguageService, useValue: { lang: signal('en') } as unknown as LanguageService },
      ],
    })
      .overrideComponent(SettingsConnectionComponent, { set: { template: '' } });
    comp = TestBed.createComponent(SettingsConnectionComponent).componentInstance;
    fetchSpy = spyOn(window, 'fetch');
    // Prime the `en` dictionary synchronously. The inline loader emits via an Observable; Transloco
    // may not have cached it by the time these synchronous label assertions read it (the computeds
    // read lazily), so setTranslation + setActiveLang force the cache now. Without this, translate()
    // returns the raw key and the label-asserting tests see e.g. 'settings.connStatusOpen'.
    const transloco = TestBed.inject(TranslocoService);
    transloco.setTranslation(translations['en'], 'en');
    transloco.setActiveLang('en');
  });
  afterEach(() => TestBed.resetTestingModule());

  // ── Realtime connection mapping ────────────────────────────────────────────────────────────

  // [state, pillClass, canRetry, label] — verifies connKey routing + the retry gate at once.
  const STATE_CASES: ReadonlyArray<[ConnectionState, string, boolean, string]> = [
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
    expect(comp.healthHint()).toBe("Probe the server's liveness endpoint (no sign-in needed).");
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
    fetchSpy.and.returnValue(
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { version: '1.2.3' } }) }),
    );
    await comp.check();
    const h = comp.health()!;
    expect(h.ok).toBe(true);
    expect(h.version).toBe('1.2.3');
    expect(typeof h.ms).toBe('number');
    expect(h.ms as number).toBeGreaterThanOrEqual(0);
    expect(fetchSpy).toHaveBeenCalledWith(`${apiPrefix()}/health`);
    expect(comp.checking()).toBe(false);
  });

  it('check() falls back to an empty version when the payload omits data.version', async () => {
    fetchSpy.and.returnValue(
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: {} }) }),
    );
    await comp.check();
    expect(comp.health()?.version).toBe('');
  });

  it('check() records an HTTP error status when the response is not ok', async () => {
    fetchSpy.and.returnValue(Promise.resolve({ ok: false, status: 503 }));
    await comp.check();
    expect(comp.health()).toEqual({ ok: false, error: 'HTTP 503' });
    expect(comp.checking()).toBe(false);
  });

  it('check() records a thrown Error message on a network failure and clears checking', async () => {
    fetchSpy.and.returnValue(Promise.reject(new Error('boom')));
    await comp.check();
    expect(comp.health()).toEqual({ ok: false, error: 'boom' });
    expect(comp.checking()).toBe(false);
  });

  it('check() maps a non-Error rejection to the generic "network" message', async () => {
    // `fetch` rejections are always Errors, but the guard exists — cover the fallback branch.
    fetchSpy.and.returnValue(Promise.reject('a bare string'));
    await comp.check();
    expect(comp.health()).toEqual({ ok: false, error: 'network' });
  });

  it('check() is re-entrancy-guarded: a second call while one is in flight is a no-op (one fetch)', async () => {
    let resolveFetch!: (v: unknown) => void;
    fetchSpy.and.returnValue(new Promise<unknown>((resolve) => (resolveFetch = resolve)));
    const first = comp.check();
    expect(comp.checking()).toBe(true);
    await comp.check(); // guard short-circuits — no second fetch call
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveFetch({ ok: true, status: 200, json: () => Promise.resolve({ data: { version: '9.9.9' } }) });
    await first;
    expect(comp.health()?.ok).toBe(true);
    expect(comp.checking()).toBe(false);
  });
});
