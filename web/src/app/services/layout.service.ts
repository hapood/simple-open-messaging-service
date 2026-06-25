import { inject, Injectable } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { BreakpointObserver } from '@angular/cdk/layout';
import { map } from 'rxjs';

// Desktop-class viewport: wide enough for the Telegram-style 3-pane AND a fine
// pointer with hover. `pointer: fine` + `hover: hover` excludes every touch
// device (phones, all iPads) regardless of UA, so iPadOS-13+'s desktop UA
// string cannot fool this. Below 1280px a 3-pane gets cramped.
const DESKTOP_QUERY = '(min-width: 1280px) and (pointer: fine) and (hover: hover)';

/**
 * Single source of truth for "is this a desktop-class viewport?". Consumed by
 * the home LayoutShell to fork the desktop vs mobile view trees; live-updates
 * on resize / orientation change.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly bpObserver = inject(BreakpointObserver);

  readonly isDesktop = toSignal(
    this.bpObserver.observe(DESKTOP_QUERY).pipe(map(result => result.matches)),
    // synchronous initial value so the first paint is correct without a tick
    { initialValue: this.bpObserver.isMatched(DESKTOP_QUERY) },
  );
}
