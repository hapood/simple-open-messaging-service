import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { InputDeviceService } from './input-device.service';

const FINE_POINTER_Q = '(pointer: fine) and (hover: hover)';

/** Build a minimal MediaQueryList — CDK MediaMatcher only reads .matches (mirrors layout.service.spec). */
function fakeMql(query: string, matches: boolean): MediaQueryList {
  return {
    matches, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
    dispatchEvent() { return false },
  } as unknown as MediaQueryList;
}

/** Native descriptor saved at module load so tests can restore the browser's real VirtualKeyboard API
 *  (desktop Chrome 145 ships it on Navigator.prototype). */
const VKB_PROTO_DESC = Object.getOwnPropertyDescriptor(Navigator.prototype, 'virtualKeyboard');

/** Force `'virtualKeyboard' in navigator` to the desired state. The `in` operator walks the prototype
 *  chain, so we must control the property on Navigator.prototype itself — an own instance prop alone cannot
 *  force ABSENCE on a browser that ships the API natively (deleting the instance prop just re-reveals the
 *  prototype getter). The native prototype attribute is configurable (WebIDL), so delete/redefine is safe. */
function setVkb(present: boolean): void {
  delete (navigator as unknown as { virtualKeyboard?: unknown }).virtualKeyboard;
  try { delete (Navigator.prototype as unknown as { virtualKeyboard?: unknown }).virtualKeyboard; }
  catch { /* non-configurable native — ignore */ }
  if (present) {
    Object.defineProperty(Navigator.prototype, 'virtualKeyboard', {
      configurable: true,
      get: () => ({ show() {}, hide() {}, overlaysContent: false, boundingRect: new DOMRect() }),
    });
  }
}

/** Restore the native VirtualKeyboard API (or leave absent) so other spec files inherit a clean navigator. */
function restoreVkb(): void {
  delete (navigator as unknown as { virtualKeyboard?: unknown }).virtualKeyboard;
  try { delete (Navigator.prototype as unknown as { virtualKeyboard?: unknown }).virtualKeyboard; }
  catch { /* ignore */ }
  if (VKB_PROTO_DESC) Object.defineProperty(Navigator.prototype, 'virtualKeyboard', VKB_PROTO_DESC);
}

describe('InputDeviceService — three input classes, derived intent signals', () => {
  let matches: Record<string, boolean>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    matches = {};
    spyOn(window as any, 'matchMedia').and.callFake((q: string) =>
      fakeMql(q, matches[q] ?? false));
    // Default: no VKB API (iOS Safari / Firefox / SSR). Per-test overrides.
    setVkb(false);
  });
  afterEach(() => {
    restoreVkb();
    TestBed.resetTestingModule();
  });

  function svc(): InputDeviceService {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), InputDeviceService],
    });
    return TestBed.inject(InputDeviceService);
  }

  it('fine pointer (mouse/trackpad) → physical; Enter sends, swap inert', () => {
    matches[FINE_POINTER_Q] = true;
    const s = svc();
    expect(s.inputClass()).toBe('physical');
    expect(s.hasPhysicalKeyboard()).toBe(true);
    expect(s.emojiSwapSupported()).toBe(false);
    expect(s.enterToSend()).toBe(true);
  });

  it('touch + VirtualKeyboard API (Android Chromium) → soft-vkb; swap supported, Enter newline', () => {
    matches[FINE_POINTER_Q] = false;
    setVkb(true);
    const s = svc();
    expect(s.inputClass()).toBe('soft-vkb');
    expect(s.hasPhysicalKeyboard()).toBe(false);
    expect(s.emojiSwapSupported()).toBe(true);
    expect(s.enterToSend()).toBe(false);
  });

  it('touch WITHOUT the VirtualKeyboard API (iOS Safari / Firefox, OR an insecure HTTP context where the API is gated off) → soft-legacy; popup fallback', () => {
    // The real-device gotcha: navigator.virtualKeyboard is HTTPS-gated (MDN: secure-context only), so over
    // http://<lan-ip> from a phone the property is absent (setVkb(false)) → soft-legacy → emojiSwapSupported()
    // false → ChatInputComponent renders the popup, NOT the swap. Production (HTTPS) gets the API → soft-vkb.
    matches[FINE_POINTER_Q] = false;
    const s = svc(); // setVkb(false) is the default
    expect(s.inputClass()).toBe('soft-legacy');
    expect(s.hasPhysicalKeyboard()).toBe(false);
    expect(s.emojiSwapSupported()).toBe(false); // → popup renders, swap panel does not
    expect(s.enterToSend()).toBe(false);
  });
});
