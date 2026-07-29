import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import {
  KeyboardInsetService,
  browserKbdInset,
  installKeyboardInsetBridge,
  uncompensatedKbdInset,
} from './keyboard-inset.service';

// Zoneless: no fakeAsync/tick. Signal-driven updates are flushed via TestBed/ApplicationRef tick.
// The module-scoped `inset` signal is shared with the eager native bridge; each test sets an explicit
// value (the bridge call or the visualViewport source's initial read) rather than relying on a clean
// starting state.

describe('browserKbdInset (pure)', () => {
  /** A minimal VisualViewport double — only height/offsetTop are read by the helper. */
  const vv = (height: number, offsetTop = 0): VisualViewport =>
    ({ height, offsetTop }) as unknown as VisualViewport;

  it('keyboard open → occlusion = layoutHeight − height − offsetTop', () => {
    expect(browserKbdInset(vv(700), 1000)).toBe(300);
  });

  it('no keyboard (vv fills the layout viewport) → 0', () => {
    expect(browserKbdInset(vv(1000), 1000)).toBe(0);
  });

  it('clamps a negative occlusion (vv taller than layout, e.g. an address-bar) → 0', () => {
    expect(browserKbdInset(vv(1100), 1000)).toBe(0);
  });

  it('offsetTop contributes to the occlusion', () => {
    expect(browserKbdInset(vv(700, 50), 1000)).toBe(250);
  });

  it('truncates fractional values to integer px', () => {
    expect(browserKbdInset(vv(700.7), 1000)).toBe(299); // 1000 − 700.7 − 0 = 299.3 → 299
  });
});

describe('uncompensatedKbdInset', () => {
  it('keeps only the IME pixels not already handled by a viewport resize', () => {
    expect(uncompensatedKbdInset(320, 280)).toBe(40);
  });

  it('clamps a fully compensated inset to zero', () => {
    expect(uncompensatedKbdInset(320, 320)).toBe(0);
    expect(uncompensatedKbdInset(320, 400)).toBe(0);
  });
});

describe('KeyboardInsetService', () => {
  let realVv: VisualViewport | null;
  let realClientHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    realVv = window.visualViewport;
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    // Restore the real visualViewport (tests that faked it replaced it on the window).
    Object.defineProperty(window, 'visualViewport', {
      value: realVv, configurable: true, writable: true,
    });
    if (realClientHeight) {
      Object.defineProperty(document.documentElement, 'clientHeight', realClientHeight);
      realClientHeight = undefined;
    }
  });

  it('available is false in the browser (no Tauri shell)', () => {
    expect(TestBed.inject(KeyboardInsetService).available).toBe(false);
  });

  it('layout override is owner-scoped and clearable only by its owner', () => {
    const svc = TestBed.inject(KeyboardInsetService);
    const owner = {};
    const stranger = {};

    svc.setLayoutOverride(owner, 12.9);
    expect(svc.layoutOverride()).toBe(12);

    svc.setLayoutOverride(stranger, null);
    expect(svc.layoutOverride()).toBe(12);

    svc.setLayoutOverride(owner, null);
    expect(svc.layoutOverride()).toBeNull();
  });

  it('the native bridge (Android push) feeds inset, clamped + integerized, and drives open', () => {
    installKeyboardInsetBridge();
    // Injecting the service on the browser path also installs the (real) visualViewport source, which
    // seeds `inset` at ~0 in a headless browser — the bridge call below then overwrites it.
    const svc = TestBed.inject(KeyboardInsetService);

    window.__SOMS_IME_EVENT__!({
      phase: 'change', currentPx: 300, targetPx: 300, durationMs: 0, animationId: 0,
      requestId: null, visible: true, isFinal: true,
    });
    expect(svc.inset()).toBe(300);
    expect(svc.open()).toBe(true);

    window.__SOMS_IME_EVENT__!({
      phase: 'change', currentPx: 0, targetPx: 0, durationMs: 0, animationId: 0,
      requestId: null, visible: false, isFinal: true,
    });
    expect(svc.inset()).toBe(0);
    expect(svc.open()).toBe(false);

    window.__SOMS_IME_EVENT__!({
      phase: 'change', currentPx: -50, targetPx: 0, durationMs: 0, animationId: 0,
      requestId: null, visible: false, isFinal: true,
    }); // negative → clamped to 0
    expect(svc.inset()).toBe(0);

    window.__SOMS_IME_EVENT__!({
      phase: 'change', currentPx: 123.9, targetPx: 123.9, durationMs: 0, animationId: 0,
      requestId: null, visible: true, isFinal: true,
    }); // fractional → truncated
    expect(svc.inset()).toBe(123);
  });

  it('the native bridge publishes and clears an endpoint-driven animation', () => {
    installKeyboardInsetBridge();
    const svc = TestBed.inject(KeyboardInsetService);

    window.__SOMS_IME_EVENT__!({
      phase: 'start',
      currentPx: 0,
      targetPx: 321.9,
      durationMs: 249.8,
      animationId: 1,
      requestId: 7,
      visible: false,
      isFinal: false,
    });
    expect(svc.animation()).toEqual({ target: 321, durationMs: 249 });

    window.__SOMS_IME_EVENT__!({
      phase: 'end',
      currentPx: 321,
      targetPx: null,
      durationMs: 0,
      animationId: 1,
      requestId: 7,
      visible: true,
      isFinal: true,
    });
    expect(svc.animation()).toBeNull();
  });

  it('moves to the Android 11 endpoint once and ignores progress layout churn', () => {
    installKeyboardInsetBridge();
    const svc = TestBed.inject(KeyboardInsetService);
    const settledVisibility = svc.visible();

    window.__SOMS_IME_EVENT__!({
      phase: 'start', currentPx: 0, targetPx: 320, durationMs: 250,
      animationId: 2, requestId: 8, visible: false, isFinal: false,
    });
    expect(svc.inset()).toBe(320);

    window.__SOMS_IME_EVENT__!({
      phase: 'progress', currentPx: 91, targetPx: 320, durationMs: 250,
      animationId: 2, requestId: 8, visible: true, isFinal: false,
    });
    expect(svc.inset()).toBe(320);
    expect(svc.visible()).toBe(settledVisibility);

    window.__SOMS_IME_EVENT__!({
      phase: 'end', currentPx: 318, targetPx: 318, durationMs: 0,
      animationId: 2, requestId: 8, visible: true, isFinal: true,
    });
    expect(svc.inset()).toBe(318);
    expect(svc.visible()).toBe(true);
  });

  it('treats a visible floating IME with zero bottom inset as open', () => {
    installKeyboardInsetBridge();
    const svc = TestBed.inject(KeyboardInsetService);

    window.__SOMS_IME_EVENT__!({
      phase: 'change', currentPx: 0, targetPx: 0, durationMs: 0,
      animationId: 3, requestId: 9, visible: true, isFinal: true,
    });

    expect(svc.inset()).toBe(0);
    expect(svc.visible()).toBe(true);
    // The browser test environment is not Android-native, so `open` follows browser occlusion here;
    // native state-machine consumers use `visible()` directly for the floating-IME distinction.
    expect(svc.open()).toBe(false);
  });

  it('visualViewport resize (browser) feeds inset and drives the open event', () => {
    // Pin the layout height so the occlusion is deterministic regardless of the test iframe size.
    realClientHeight = Object.getOwnPropertyDescriptor(document.documentElement, 'clientHeight');
    Object.defineProperty(document.documentElement, 'clientHeight', {
      get: () => 1000, configurable: true,
    });

    // A minimal VisualViewport double with a dispatcher for the resize/scroll listeners.
    const listeners: Array<() => void> = [];
    const fakeVv = {
      height: 1000, offsetTop: 0,
      addEventListener: (_t: string, cb: () => void) => listeners.push(cb),
      removeEventListener: (_t: string, cb: () => void) => {
        const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1);
      },
    };
    Object.defineProperty(window, 'visualViewport', {
      value: fakeVv, configurable: true, writable: true,
    });

    const svc = TestBed.inject(KeyboardInsetService);
    expect(svc.inset()).toBe(0);   // vv fills the layout viewport → no keyboard
    expect(svc.open()).toBe(false);

    fakeVv.height = 700;           // keyboard opens → occludes 300px
    for (const cb of listeners) cb();
    expect(svc.inset()).toBe(300);
    expect(svc.open()).toBe(true);

    fakeVv.height = 1000;          // keyboard closes
    for (const cb of listeners) cb();
    expect(svc.inset()).toBe(0);
    expect(svc.open()).toBe(false);
  });
});
