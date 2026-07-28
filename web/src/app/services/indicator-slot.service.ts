import { Injectable, signal } from '@angular/core';

/**
 * Visibility state for the global top-center status slot. The connection indicator currently owns this
 * slot; update and event notifications use the standard bottom Material snackbar instead.
 */
@Injectable({ providedIn: 'root' })
export class IndicatorSlotService {
  /** True while the connection indicator is visible. */
  readonly priorityOccupied = signal(false);
}
