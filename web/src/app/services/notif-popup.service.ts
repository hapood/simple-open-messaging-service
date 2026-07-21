import { Injectable, signal } from '@angular/core';
import type { NotificationDescriptor } from './notification-descriptor.model';

/**
 * The in-app notification-popup state — a signal of the active {@link NotificationDescriptor} cards the
 * foreground away-renderer wants surfaced as a rich in-app popup (the "新弹窗" surface). Backed by a
 * `Map<tag, descriptor>` so posting a new descriptor with the same `tag` REPLACES the prior one in place
 * (the same replace-by-tag semantics the system notification uses) — the popup list never stacks duplicates.
 *
 * Written by {@link UnreadAttentionService.pullAndRender} (alongside the system-notification adapter) and
 * cleared on focus-regain; the popup component renders each card + its action buttons. Independent of the
 * system notification: on platforms where in-page Notification action buttons don't fire (the Web
 * `notificationclick` + `event.action` only work in a SW context), THIS popup is the reliable action surface.
 */
@Injectable({ providedIn: 'root' })
export class NotifPopupService {
  private readonly byTag = new Map<string, NotificationDescriptor>();
  private readonly _popups = signal<NotificationDescriptor[]>([]);
  /** The active popup cards (one per distinct `tag`). */
  readonly popups = this._popups.asReadonly();

  /** Show / replace popup cards by `tag` (same tag → replace in place, never stack). */
  show(list: NotificationDescriptor[]): void {
    for (const d of list) {
      if (d.kind === 'clear') {
        // A clear descriptor cancels the tagged popup (server-driven dismiss).
        this.byTag.delete(d.tag);
      } else {
        this.byTag.set(d.tag, d);
      }
    }
    this._popups.set([...this.byTag.values()]);
  }

  /** Dismiss the popup with this `tag`. */
  dismiss(tag: string): void {
    if (this.byTag.delete(tag)) this._popups.set([...this.byTag.values()]);
  }

  /** Dismiss all popups (focus-regain / logout). */
  clear(): void {
    if (this.byTag.size === 0) return;
    this.byTag.clear();
    this._popups.set([]);
  }
}
