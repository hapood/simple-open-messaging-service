import { computed, inject, Injectable, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { BreakpointObserver } from '@angular/cdk/layout';
import { map } from 'rxjs';

// Desktop-class viewport: wide enough for the Telegram-style 3-pane AND a fine
// pointer with hover. `pointer: fine` + `hover: hover` excludes every touch
// device (phones, all iPads) regardless of UA, so iPadOS-13+'s desktop UA
// string cannot fool this. Below 1280px a 3-pane gets cramped.
const DESKTOP_QUERY = '(min-width: 1280px) and (pointer: fine) and (hover: hover)';
// Tablet / landscape-large-phone width: enough for a side-by-side 2-pane.
// 768 = iPad mini portrait / Bootstrap md; landscape phones (~844px) qualify too.
const WIDE_QUERY = '(min-width: 768px)';
// Fine pointer + hover, with NO width clause: a desktop-class INPUT device
// (mouse/trackpad ⇒ a physical keyboard is present; no soft keyboard). This is
// width-independent on purpose — a small laptop window or a narrow Tauri desktop
// shell still has a physical keyboard, so Enter-to-send and the absence of the
// VKB swap must NOT flip just because the viewport shrank below the 3-pane width.
// Use this for keyboard-convention decisions; use {@link isDesktop} for layout.
const FINE_POINTER_QUERY = '(pointer: fine) and (hover: hover)';

export type LayoutMode = 'mobile' | 'tablet' | 'desktop';

/**
 * Single source of truth for the viewport class. Consumed by the home
 * LayoutShell to fork desktop / tablet / mobile view trees.
 *
 * `mode` is a 3-way computed: desktop wins (fine pointer + hover), else
 * ≥768px → tablet 2-pane, else mobile 1-pane. BreakpointObserver watches
 * matchMedia, so device rotation (which changes viewport width) live-updates
 * the mode and the shell swaps in place — no separate orientation listener
 * needed. Initial values are synchronous so first paint is correct without a tick.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly bpObserver = inject(BreakpointObserver);

  readonly isDesktop = toSignal(
    this.bpObserver.observe(DESKTOP_QUERY).pipe(map(result => result.matches)),
    { initialValue: this.bpObserver.isMatched(DESKTOP_QUERY) },
  );

  /** Fine-pointer input modality (physical keyboard present), independent of viewport
   *  width. Drives the chat composer's Enter convention (Enter sends on a physical
   *  keyboard; Enter inserts a newline on a touch/soft-keyboard device) and the
   *  emoji-keyboard VKB-swap eligibility. NOT a layout signal. */
  readonly hasFinePointer = toSignal(
    this.bpObserver.observe(FINE_POINTER_QUERY).pipe(map(result => result.matches)),
    { initialValue: this.bpObserver.isMatched(FINE_POINTER_QUERY) },
  );

  /** viewport ≥768px (tablet / landscape phone width). */
  readonly isWide = toSignal(
    this.bpObserver.observe(WIDE_QUERY).pipe(map(result => result.matches)),
    { initialValue: this.bpObserver.isMatched(WIDE_QUERY) },
  );

  readonly mode = computed<LayoutMode>(() =>
    this.isDesktop() ? 'desktop' : this.isWide() ? 'tablet' : 'mobile'
  );

  // ── Immunity frame ──────────────────────────────────────────────────────────
  // During a route-transition animation (the mobile chat-slot slide-in/out) the OS
  // frequently fires visualViewport resize/scroll (address-bar collapse, layout
  // viewport settling) and the chat-slot's own ResizeObserver. Letting those reach
  // the virtual-scroll kernel mid-slide causes a re-pin/balance that visibly jumps
  // the message list UNDER the sliding overlay. freezeReflow() / thawReflow() bracket
  // the animation; while frozen, reactors (kernel.onViewportResize, the input-bar
  // keyboardOffset effect) hold their state and flush exactly once on thaw.
  // Counter-based so overlapping start/done callbacks (interrupted transitions) stay
  // balanced — every freeze has a matching thaw, and thaw floors at 0.
  private readonly freezeCount = signal(0);
  /** True while a route-transition immunity frame is active. Read by reactors that
   *  must not respond to viewport changes mid-animation. */
  readonly reflowFrozen = computed(() => this.freezeCount() > 0);
  freezeReflow(): void { this.freezeCount.update((c) => c + 1); }
  thawReflow(): void { this.freezeCount.update((c) => Math.max(0, c - 1)); }
}
