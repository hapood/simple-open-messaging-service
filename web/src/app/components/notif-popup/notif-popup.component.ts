import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { DomSanitizer, type SafeUrl } from '@angular/platform-browser';
import { NotifPopupService } from '../../services/notif-popup.service';
import { NotificationActionHttp } from '../../services/notif-action.service';
import { ConversationListService } from '../../services/conversation-list.service';
import type { NotificationDescriptor, NotifAction } from '../../services/notification-descriptor.model';

/**
 * The in-app notification popup — the foreground's rich "新弹窗" surface. Renders the active descriptor
 * cards from {@link NotifPopupService} as an overlay (icon + title + body + action buttons). Action buttons
 * report back via {@link NotificationActionHttp} then dismiss the card; this is the RELIABLE action surface
 * on platforms where in-page `Notification` action buttons don't fire (Web `notificationclick` + `event.action`
 * only work in a SW context — the shade notification there shows the same buttons, but in-tab they need this).
 *
 * Pure render of service state — no fetch logic of its own (UnreadAttentionService feeds the service). Fixed
 * at the top trailing edge on desktop/tablet, away from the top-center connection status; compact screens
 * place it below the app header/status lane. Transient (cleared on focus-regain). One card per distinct
 * `tag` (replace-by-tag).
 */
@Component({
  selector: 'app-notif-popup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (d of cards(); track d.tag) {
      <div class="notif-card" role="alert">
        @if (safeIcon(d); as icon) {
          <img class="notif-icon" [src]="icon" alt="" />
        }
        <div class="notif-content">
          @if (d.title) {
            <div class="notif-title">{{ d.title }}</div>
          }
          <div class="notif-body">{{ d.body }}</div>
        </div>
        <div class="notif-actions">
          @for (a of d.actions; track a.id) {
            <button type="button" class="notif-btn" (click)="onAction(d, a)">{{ a.title }}</button>
          }
          <button
            type="button"
            class="notif-close"
            (click)="popup.dismiss(d.tag)"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        position: fixed;
        top: calc(16px + var(--soms-safe-top, 0px));
        right: 16px;
        z-index: 900; /* shell (40) < this toast < modal (1000) */
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: none; /* the container never blocks; each card re-enables */
        width: min(92vw, 440px);
      }
      @media (max-width: 599px) {
        :host {
          top: calc(108px + var(--soms-safe-top, 0px));
          right: auto;
          left: 50%;
          transform: translateX(-50%);
        }
      }
      .notif-card {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        background: var(--app-surface-elevated, #fff);
        color: var(--app-text, #111);
        border: 1px solid var(--app-border, #ddd);
        border-radius: 12px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
      }
      .notif-icon {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        flex: 0 0 auto;
        object-fit: cover;
      }
      .notif-content {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .notif-title {
        font-size: 13px;
        line-height: 18px;
        font-weight: 600;
      }
      .notif-body {
        font-size: 14px;
        line-height: 20px;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .notif-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: 0 0 auto;
      }
      .notif-btn {
        border: none;
        background: var(--app-brand, #2563eb);
        color: #fff;
        font-size: 13px;
        line-height: 18px;
        padding: 6px 10px;
        border-radius: 8px;
        cursor: pointer;
      }
      .notif-close {
        border: none;
        background: transparent;
        color: var(--app-text-muted, #888);
        font-size: 20px;
        line-height: 20px;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        cursor: pointer;
      }
    `,
  ],
})
export class NotifPopupComponent {
  readonly popup = inject(NotifPopupService);
  private readonly actionHttp = inject(NotificationActionHttp);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly convList = inject(ConversationListService);

  /** The active popup cards (only non-clear descriptors have a body to show). */
  readonly cards = computed(() => this.popup.popups());

  /** The icon is a server-controlled same-origin URL; sanitize for the [src] binding. */
  safeIcon(d: NotificationDescriptor): SafeUrl | null {
    return d.icon ? this.sanitizer.bypassSecurityTrustUrl(d.icon) : null;
  }

  /** Handle an action button tap. `dismiss` is a PURE frontend shade-close (no POST, no read-watermark change);
   *  any other action (`reply`, …) reports to the backend then dismisses. Routing fields come from the
   *  descriptor's `data` (empty for the summary's `dismiss`; a future single-message kind carries threadId+seq). */
  onAction(d: NotificationDescriptor, a: NotifAction): void {
    if (a.id === 'dismiss') {
      // Pure frontend: advance the away-HWM to the descriptor's cursor (the newest message it covered) so the
      // next background fetch's `since` gates past these messages (no re-fire), then close the card. No POST,
      // no read-watermark change.
      if (d.data?.threadId != null && d.data?.seq != null) {
        this.convList.advanceMissedCursor({ threadId: d.data.threadId, seq: d.data.seq });
      }
      this.popup.dismiss(d.tag);
      return;
    }
    const report: { tag: string; actionId: string; threadId?: number; seq?: number; replyText?: string } = {
      tag: d.tag,
      actionId: a.id,
    };
    // Carry only the routing fields the descriptor actually has (omit undefined keys → a clean POST body).
    if (d.data?.threadId != null) report.threadId = d.data.threadId;
    if (d.data?.seq != null) report.seq = d.data.seq;
    void this.actionHttp.report(report);
    this.popup.dismiss(d.tag);
  }
}
