import { computed, inject, Injectable, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { BreakpointObserver } from '@angular/cdk/layout';
import { map } from 'rxjs';

// Window-size classes (Material adaptive-layout model), width-only:
//   compact  < 720px  — one column; chat/details are full-screen overlays
//   medium   720–1099 — conversation list + inline chat; no permanent icon rail
//   expanded ≥ 1100px — icon rail + resizable conversation list + inline chat
// Input modality remains independent in InputDeviceService: a touch tablet can use the medium/expanded
// layout while its composer still follows soft-keyboard behavior.
const MEDIUM_QUERY = '(min-width: 720px)';
const EXPANDED_QUERY = '(min-width: 1100px)';

export type LayoutMode = 'compact' | 'medium' | 'expanded';

/**
 * Single source of truth for the LAYOUT axis — the viewport class (one column vs two), pure width. Consumed
 * by the home shell to fork the desktop / mobile view trees.
 *
 * BreakpointObserver watches matchMedia, so device rotation/window resize live-updates the mode and the shell
 * swaps in place. Initial values are synchronous so first paint is correct without a tick.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly bpObserver = inject(BreakpointObserver);

  readonly isAtLeastMedium = toSignal(
    this.bpObserver.observe(MEDIUM_QUERY).pipe(map(result => result.matches)),
    { initialValue: this.bpObserver.isMatched(MEDIUM_QUERY) },
  );

  readonly isExpanded = toSignal(
    this.bpObserver.observe(EXPANDED_QUERY).pipe(map(result => result.matches)),
    { initialValue: this.bpObserver.isMatched(EXPANDED_QUERY) },
  );

  /** Compatibility/readability alias for surfaces whose desktop treatment is expanded-only (wide dialogs,
   *  the development playground, fit-dialog measurement). New adaptive shell code should prefer `mode`. */
  readonly isDesktop = this.isExpanded;

  readonly mode = computed<LayoutMode>(() =>
    this.isExpanded() ? 'expanded' : this.isAtLeastMedium() ? 'medium' : 'compact',
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
