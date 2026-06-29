import { computed, inject, Injectable } from '@angular/core';
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

  /** viewport ≥768px (tablet / landscape phone width). */
  readonly isWide = toSignal(
    this.bpObserver.observe(WIDE_QUERY).pipe(map(result => result.matches)),
    { initialValue: this.bpObserver.isMatched(WIDE_QUERY) },
  );

  readonly mode = computed<LayoutMode>(() =>
    this.isDesktop() ? 'desktop' : this.isWide() ? 'tablet' : 'mobile'
  );
}
