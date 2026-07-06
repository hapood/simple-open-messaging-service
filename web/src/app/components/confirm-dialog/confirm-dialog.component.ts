import { Component, ChangeDetectionStrategy, input, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';

/**
 * Generic app-level "are you sure?" dialog — the unmissable confirm for destructive / consequential
 * actions. Opened via {@link PopupType.CONFIRM} on the shared root popup layer, so it inherits the
 * backdrop, the centered desktop card / full-screen mobile sheet, the enter/leave motion, the
 * history-back-to-cancel contract, and the z-1000 modal tier (above every shell/pane layer, below only
 * the lightbox viewers) — all without per-call wiring.
 *
 * The dialog is fully parameterized by translation keys + a danger flag so any caller can reuse it:
 *   confirm(true)  → confirm button / Enter
 *   cancel()       → cancel button / system-back (delivers undefined, treated as "no")
 * Only a `true` result triggers the caller's action, so a back-button dismiss is indistinguishable from
 * the Cancel button — the action never fires on an accidental dismiss.
 *
 * Heights follow the project integer-pixel rule (integer line-heights + paddings) so the dialog card's
 * offsetHeight is whole-pixel at any line wrap count.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [TranslocoPipe, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="confirm" [class.danger]="danger()">
      <div class="badge">
        <app-icon [type]="icon()" [style]="{ width: '34px', height: '34px' }"></app-icon>
      </div>
      @if (titleKey(); as title) {
        <h2 class="title">{{ title | transloco }}</h2>
      }
      <p class="message">{{ messageKey() | transloco: messageParams() }}</p>
      <div class="actions">
        <button type="button" class="btn ghost" (click)="cancel()">
          {{ cancelKey() | transloco }}
        </button>
        <button type="button" class="btn solid" (click)="confirm()">
          {{ confirmKey() | transloco }}
        </button>
      </div>
    </div>
  `,
  styles: [`
    .confirm {
      /* Center the content both inside the desktop card (auto height, screen-centered by the wrapper's
         translate) and the full-screen mobile sheet (100% height → vertical centering kicks in). */
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100%;
      box-sizing: border-box;
      padding: 28px 24px;
      text-align: center;
    }

    /* Large tinted glyph circle — the "瞩目" focal point that reads as a warning at a glance. Brand tint
       by default; the danger variant flips to the danger token (red). */
    .badge {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 64px;
      height: 64px;
      border-radius: var(--app-radius-pill);
      background: var(--app-brand-soft);
      color: var(--app-brand);
      margin-bottom: 16px;
    }
    .confirm.danger .badge {
      background: var(--app-danger-soft);
      color: var(--app-danger);
    }

    .title {
      margin: 0 0 8px;
      font-size: 18px;
      font-weight: 600;
      line-height: 24px; /* integer line-height */
      color: var(--app-text);
    }

    .message {
      margin: 0 0 24px;
      max-width: 360px;
      font-size: 14px;
      line-height: 20px; /* integer line-height */
      color: var(--app-text-muted);
      white-space: normal;
      word-break: break-word;
    }

    .actions {
      display: flex;
      gap: 12px; /* integer gap */
      width: 100%;
      max-width: 360px;
    }

    .btn {
      flex: 1 1 0;
      height: 42px;
      padding: 0 16px;
      border: 1px solid transparent;
      border-radius: var(--app-radius-md);
      font-size: 14px;
      font-weight: 600;
      line-height: 20px; /* integer line-height */
      cursor: pointer;
      box-sizing: border-box;
    }
    .btn.ghost {
      background: transparent;
      border-color: var(--app-border-strong);
      color: var(--app-text);
    }
    .btn.ghost:hover { background: var(--app-hover); }
    .btn.solid {
      background: var(--app-brand);
      color: #fff;
    }
    .btn.solid:hover { background: var(--app-brand-hover); }
    /* Destructive variant: the confirming button wears the danger fill so the irreversible action is the
       visually-heaviest control (Material's "destructive buttons name + emphasize the action" guidance). */
    .confirm.danger .btn.solid {
      background: var(--app-danger);
    }
  `],
})
export class ConfirmDialogComponent {
  private readonly routeService = inject(RouteService);

  /** Glyph in the badge. Defaults to the warning triangle (REPORT icon). */
  readonly icon = input(AppIconType.REPORT);
  /** Optional bold heading above the message. Omit for message-only confirms. */
  readonly titleKey = input<string>();
  /** Required body copy. May be parameterized via {@link messageParams}. */
  readonly messageKey = input.required<string>();
  readonly messageParams = input<Record<string, unknown>>({});
  /** Confirm-button label key. Defaults to the generic "Confirm"; destructive callers pass the verb. */
  readonly confirmKey = input('common.confirm');
  /** Cancel-button label key. */
  readonly cancelKey = input('common.cancel');
  /** When true, the badge + confirm button flip to the danger (red) treatment. */
  readonly danger = input(false);

  confirm(): void {
    this.routeService.closeDlg(true);
  }

  cancel(): void {
    this.routeService.closeDlg(undefined);
  }
}
