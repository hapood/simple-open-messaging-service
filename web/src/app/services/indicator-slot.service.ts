import { Injectable, signal } from '@angular/core';

/**
 * The **indicator slot** — the single fixed top-right corner of the viewport where one status indicator
 * shows at a time. Two indicators compete for it:
 *
 *  1. {@link ConnectionBannerComponent} — the SSE connection chip (connecting / reconnecting / recovered).
 *     PRIORITY occupant: it always wins the slot and shows immediately.
 *  2. {@link UpdateBannerComponent} — the "new version available" pill. Lower priority: it DEFERS while
 *     the connection chip is showing, and surfaces once the chip clears — if an update is still pending.
 *
 * Why a single slot with priority (rather than letting both stack): the corner is small, the two states
 * read similarly (a colored tonal-fill pill), and showing both at once would compete for the user's
 * attention. A connection problem is more urgent than a pending deploy, so it wins; the update simply
 * waits its turn. "When one is gone, the second shows if it still wants to."
 *
 * Coordination is a one-way handoff: the connection chip reports its visibility here via
 * `priorityOccupied`; the update banner reads it to gate its own visibility. Neither knows the other
 * exists — both only talk to this service.
 */
@Injectable({ providedIn: 'root' })
export class IndicatorSlotService {
  /** True while the priority occupant (the connection chip) is visible. Set by the connection chip;
   *  read by the update banner to decide whether to defer. */
  readonly priorityOccupied = signal(false);
}
