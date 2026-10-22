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
 *    via `WindowInsets` and publishes structured `window.__SOMS_IME_EVENT__` geometry events, installed
 *    eagerly by {@link installKeyboardInsetBridge} BEFORE bootstrap so the first native frame is never missed.
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
export interface KeyboardInsetAnimation {
  target: number;
  durationMs: number;
}
interface ImeGeometryEvent {
  phase: 'prepare' | 'start' | 'progress' | 'end' | 'change';
  currentPx: number;
  targetPx: number | null;
  durationMs: number;
  animationId: number;
  requestId: number | null;
  visible: boolean;
  isFinal: boolean;
}
const animation = signal<KeyboardInsetAnimation | null>(null);
const imeVisible = signal(false);
const geometryEvent = signal<ImeGeometryEvent | null>(null);
const layoutOverride = signal<number | null>(null);
let layoutOverrideOwner: object | null = null;
const viewportReduction = signal(0);
// Timestamp namespace prevents a page reload from reusing a request id while a native animation from the
// previous JS context is still completing. Millisecond epoch ×1000 remains below Number.MAX_SAFE_INTEGER.
let imeRequestSeq = Date.now() * 1000;
let latestImeRequestId: number | null = null;

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

/** Remove the part of the IME height the browser/WebView has already handled by shrinking its layout
 * viewport. Some Android WebViews resize despite also publishing the full native IME inset; translating
 * by that full value again would lift the composer twice. */
export function uncompensatedKbdInset(rawInset: number, reducedBy: number): number {
  return clampPx(rawInset - Math.max(0, reducedBy));
}

/** Install the native→JS push before bootstrap so the first native frame is never missed. Seeds the
 *  current value in case the keyboard is somehow already open at boot. No-op in effect outside the
 *  Android shell — the global is installed unconditionally but is only ever called by `MainActivity`
 *  there. Follows the `__SOMS_<NAME>__` bridge-hook convention. */
export function installKeyboardInsetBridge(): void {
  if (typeof window === 'undefined') return;
  const accept = (event: ImeGeometryEvent): void => {
    const normalized: ImeGeometryEvent = {
      ...event,
      currentPx: clampPx(event.currentPx),
      targetPx: event.targetPx === null ? null : clampPx(event.targetPx),
      durationMs: Math.max(0, Math.trunc(event.durationMs)),
    };
    geometryEvent.set(normalized);
    const staleRequestedAnimation =
      event.requestId !== null &&
      latestImeRequestId !== null &&
      event.requestId !== latestImeRequestId;
    if (event.phase === 'start' && event.targetPx !== null && !staleRequestedAnimation) {
      // Endpoint-driven Android 11+ layout: write the destination once and let CSS animate there using
      // the native duration. Progress events remain observable but never cause Angular layout churn.
      inset.set(clampPx(event.targetPx));
      animation.set({
        target: clampPx(event.targetPx),
        durationMs: Math.max(0, Math.trunc(event.durationMs)),
      });
    }
    if (event.isFinal) {
      inset.set(clampPx(event.currentPx));
      imeVisible.set(event.visible);
      animation.set(null);
    }
  };
  window.__SOMS_IME_EVENT__ = accept;
  const raw = window.SomsShell?.getImeSnapshot?.();
  if (!raw) return;
  try {
    const snapshot = JSON.parse(raw) as {
      currentPx?: unknown;
      visible?: unknown;
      requestId?: unknown;
    };
    if (typeof snapshot.currentPx === 'number') {
      accept({
        phase: 'change',
        currentPx: snapshot.currentPx,
        targetPx: snapshot.currentPx,
        durationMs: 0,
        animationId: 0,
        requestId: typeof snapshot.requestId === 'number' ? snapshot.requestId : null,
        visible: snapshot.visible === true,
        isFinal: true,
      });
    }
  } catch {
    // A malformed optional native snapshot must not block Angular bootstrap.
  }
}

@Injectable({ providedIn: 'root' })
export class KeyboardInsetService {
  /** Current keyboard occlusion height (CSS px, 0 when closed). Updated by the native push (Android) or
   *  the `visualViewport` listener (browser). */
  readonly inset = inset.asReadonly();
  /** API 30+ animation endpoint. While present, layout surfaces move directly to `target` once instead of
   *  chasing every `inset` frame delivered by the native animation callback. */
  readonly animation = animation.asReadonly();
  /** Whether the system IME is active. Independent of bottom occlusion: floating keyboards are visible
   * while reporting a zero inset. */
  readonly visible = imeVisible.asReadonly();
  /** Latest native geometry event, including final/visibility/request correlation metadata. */
  readonly event = geometryEvent.asReadonly();
  /** Keyboard-open event. On native Android this follows visibility; browsers derive it from occlusion. */
  readonly open = computed(() => this.available ? imeVisible() : inset() > 0);
  /** Composer-owned layout override. During an explicit native↔custom keyboard handoff the custom panel
   *  already occupies the keyboard slot, so layout must temporarily ignore native IME animation frames. */
  readonly layoutOverride = layoutOverride.asReadonly();
  /** Amount by which the layout viewport has already shrunk while the IME is open. Consumers subtract
   * this from the native inset so resize + translation never compensate for the same pixels twice. */
  readonly viewportReduction = viewportReduction.asReadonly();
  /** True only inside the Android Tauri shell, where the native-injected inset is authoritative
   *  (`visualViewport` is blind to the IME there). */
  readonly available = isTauri() && isAndroid();

  /** Atomic visibility capability. The caller must establish/clear DOM focus; actual geometry is observed
   *  asynchronously through `inset`/`animation`, never inferred from this request succeeding. */
  setVisible(visible: boolean): number | null {
    if (typeof window === 'undefined' || !window.SomsShell?.setImeVisible) return null;
    const requestId = ++imeRequestSeq;
    latestImeRequestId = requestId;
    // Keep the injected object as receiver; extracting @JavascriptInterface methods breaks on Huawei.
    window.SomsShell.setImeVisible(visible, requestId);
    return requestId;
  }

  /** Re-read native truth after a transition watchdog expires. Feeding it through the same bridge gives
   * every consumer one final event path instead of a second snapshot-specific state machine. */
  reconcileSnapshot(): boolean {
    const raw = typeof window !== 'undefined' ? window.SomsShell?.getImeSnapshot?.() : null;
    if (!raw || !window.__SOMS_IME_EVENT__) return false;
    try {
      const snapshot = JSON.parse(raw) as {
        currentPx?: unknown;
        visible?: unknown;
        requestId?: unknown;
      };
      if (typeof snapshot.currentPx !== 'number' || typeof snapshot.visible !== 'boolean') return false;
      window.__SOMS_IME_EVENT__({
        phase: 'change',
        currentPx: snapshot.currentPx,
        targetPx: snapshot.currentPx,
        durationMs: 0,
        animationId: 0,
        requestId: typeof snapshot.requestId === 'number' ? snapshot.requestId : null,
        visible: snapshot.visible,
        isFinal: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  setLayoutOverride(owner: object, value: number | null): void {
    if (value === null) {
      if (layoutOverrideOwner !== owner) return;
      layoutOverrideOwner = null;
      layoutOverride.set(null);
      return;
    }
    layoutOverrideOwner = owner;
    layoutOverride.set(clampPx(value));
  }

  constructor() {
    // Android: the eager native bridge (main.ts) feeds `inset`; `visualViewport` is blind, so skip its
    // source. Browser/PWA/iOS/desktop: install the `visualViewport` listener (lazy — no native pushes to
    // race) and tear it down with the injector (tests reset; the root singleton never destroys in prod).
    if (this.available) {
      // Capture the largest observed layout height as the unoccluded baseline. A keyboard-driven resize
      // only makes it smaller, so it cannot corrupt the baseline even if resize arrives before the native
      // inset event. This also tolerates Android WebViews that do not resize (reduction remains zero).
      let baseline = document.documentElement.clientHeight;
      const updateReduction = (): void => {
        const current = document.documentElement.clientHeight;
        baseline = Math.max(baseline, current);
        viewportReduction.set(Math.max(0, baseline - current));
      };
      window.addEventListener('resize', updateReduction);
      updateReduction();
      inject(DestroyRef).onDestroy(() => window.removeEventListener('resize', updateReduction));
      return;
    }
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const update = (): void => {
      const next = browserKbdInset(vv);
      inset.set(next);
      imeVisible.set(next > 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    inject(DestroyRef).onDestroy(() => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    });
  }
}
