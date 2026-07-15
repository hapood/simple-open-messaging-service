import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { isAndroid, isTauri } from './runtime';

/**
 * The single source of soft-keyboard (IME) occlusion height for the whole app.
 *
 * Two platform event sources are unified into one `inset` signal — consumers ({@link KbdOffsetDirective}
 * via `appKbdOffset`) read `inset()` and never re-measure or branch on platform:
 *
 *  - Android Tauri shell: the WebView is edge-to-edge and `window.visualViewport` does NOT reflect the
 *    IME (`env(safe-area-inset-*)` is 0 there for the same reason). `MainActivity` measures the IME inset
 *    via `WindowInsets` and pushes it per animation frame (API 30+) through
 *    `window.__SOMS_IME_HEIGHT__`, installed eagerly by {@link installKeyboardInsetBridge} BEFORE
 *    bootstrap so the first native frame is never missed.
 *  - Browser / PWA / iOS / desktop: `window.visualViewport` resize/scroll. The layout viewport does not
 *    resize on touch browsers (the default `interactive-widget=resizes-visual` keeps the ICB at the full
 *    screen size), so the occlusion = layoutViewportHeight − visualViewport.height −
 *    visualViewport.offsetTop — the pure {@link browserKbdInset} helper.
 *
 * `inset` is the keyboard's occlusion of the layout viewport in CSS px (0 when closed). `open` is the
 * derived keyboard-open event (`inset > 0`). On Android the native push is authoritative (`available` —
 * `visualViewport` is blind there); elsewhere the `visualViewport` source drives `inset`.
 */

/** The shared occlusion-height signal: fed by the native bridge (Android) or the `visualViewport`
 *  listener (browser). Module-scoped so the eager bridge function — which runs before DI exists — and
 *  the service share one signal. */
const inset = signal(0);

/** Clamp + integerize a raw keyboard height (defensive: the native push or `visualViewport` may report
 *  fractional / negative values under edge cases). */
function clampPx(px: number): number {
  return Math.max(0, Math.trunc(px));
}

/** Pure: the keyboard's occlusion of the layout viewport (CSS px) from a `VisualViewport` snapshot. The
 *  layout viewport height is the `documentElement` clientHeight — stable on touch browsers (the ICB does
 *  not resize when the keyboard opens), so this carries the FULL keyboard height. Exported for unit
 *  testing; pass `layoutHeight` to test without a DOM. */
export function browserKbdInset(
  vv: VisualViewport,
  layoutHeight: number = typeof document !== 'undefined' ? document.documentElement.clientHeight : 0,
): number {
  return clampPx(layoutHeight - vv.height - vv.offsetTop);
}

/** Install the native→JS push before bootstrap so the first native frame is never missed. Seeds the
 *  current value in case the keyboard is somehow already open at boot. No-op in effect outside the
 *  Android shell — the global is installed unconditionally but is only ever called by `MainActivity`
 *  there. Follows the `__SOMS_<NAME>__` bridge-hook convention. */
export function installKeyboardInsetBridge(): void {
  if (typeof window === 'undefined') return;
  window.__SOMS_IME_HEIGHT__ = (px: number): void => { inset.set(clampPx(px)); };
  const current = window.SomsShell?.getImeHeight?.();
  if (typeof current === 'number' && current > 0) inset.set(current);
}

@Injectable({ providedIn: 'root' })
export class KeyboardInsetService {
  /** Current keyboard occlusion height (CSS px, 0 when closed). Updated by the native push (Android) or
   *  the `visualViewport` listener (browser). */
  readonly inset = inset.asReadonly();
  /** Keyboard-open event: true while a soft keyboard occludes the viewport. */
  readonly open = computed(() => inset() > 0);
  /** True only inside the Android Tauri shell, where the native-injected inset is authoritative
   *  (`visualViewport` is blind to the IME there). */
  readonly available = isTauri() && isAndroid();

  constructor() {
    // Android: the eager native bridge (main.ts) feeds `inset`; `visualViewport` is blind, so skip its
    // source. Browser/PWA/iOS/desktop: install the `visualViewport` listener (lazy — no native pushes to
    // race) and tear it down with the injector (tests reset; the root singleton never destroys in prod).
    if (this.available) return;
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const update = (): void => inset.set(browserKbdInset(vv));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    inject(DestroyRef).onDestroy(() => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    });
  }
}
