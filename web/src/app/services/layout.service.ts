import { computed, inject, Injectable, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { BreakpointObserver } from '@angular/cdk/layout';
import { map } from 'rxjs';

// Desktop-class viewport: wide enough for the icon-rail + two-column (list | chat). PURE WIDTH — the
// input-modality axis (physical vs soft keyboard) is owned by InputDeviceService, so a wide touch tablet
// (iPad Pro landscape, Samsung DeX) correctly lands in desktop mode while its input bar still behaves as
// soft-keyboard. Below 1024px the two-column gets cramped; the app falls back to the single-column mobile
// shell (full-screen home sections + full-screen overlays).
const DESKTOP_QUERY = '(min-width: 1024px)';

export type LayoutMode = 'mobile' | 'desktop';

/**
 * Single source of truth for the LAYOUT axis — the viewport class (one column vs two), pure width. Consumed
 * by the home shell to fork the desktop / mobile view trees.
 *
 * `mode` is a 2-way computed: ≥1024px → desktop (icon-rail + resizable list + chat columns), else mobile
 * (full-screen list/secondary sections + full-screen chat/aside overlays) — width only, NO
 * pointer/hover clause. The INPUT axis (physical vs soft keyboard) lives in {@link InputDeviceService} so the
 * two concerns cannot recouple. BreakpointObserver watches matchMedia, so device rotation live-updates the
 * mode and the shell swaps in place. Initial values are synchronous so first paint is correct without a tick.
 *
 * Was 3-way with a tablet master/detail middle; collapsed to 2 — the tablet variant wasn't pulling its
 * weight, and its concerns split cleanly: the two-column aspect folds into desktop, the full-screen-overlay
 * aspect into mobile. The old 768–1280 range now straddles 1024 — its upper half is desktop, lower half mobile.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly bpObserver = inject(BreakpointObserver);

  readonly isDesktop = toSignal(
    this.bpObserver.observe(DESKTOP_QUERY).pipe(map(result => result.matches)),
    { initialValue: this.bpObserver.isMatched(DESKTOP_QUERY) },
  );

  readonly mode = computed<LayoutMode>(() => this.isDesktop() ? 'desktop' : 'mobile');

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
