import { Component, ChangeDetectionStrategy, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe } from '@jsverse/transloco';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';

/**
 * Once-per-launch, non-blocking notice shown when the running shell is incompatible with the backend it
 * connected to (the server's version is at/above this shell's hard-coded `COMPAT_BACKEND_MAX`). The shell
 * cannot self-update its binary (Tauri can't replace its own APK/desktop binary), so the only remedy is a
 * newer build from the administrator — hence a single "acknowledge" button, not a confirm/cancel pair.
 * Opened via {@link PopupType.SHELL_INCOMPATIBLE} on the shared root popup layer, so it inherits the
 * backdrop, the centered responsive modal card, the enter/leave motion, the
 * system-back-to-dismiss contract, and the z-1000 modal tier — all without per-call wiring.
 *
 * Heights follow the project integer-pixel rule (integer line-heights + paddings) so the dialog card's
 * offsetHeight is whole-pixel at any line wrap count.
 */
@Component({
  selector: 'app-shell-incompatible-dialog',
  imports: [MatButtonModule, TranslocoPipe, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dialog">
      <div class="badge">
        <app-icon [type]="AppIconType.REPORT" [style]="{ width: '34px', height: '34px' }"></app-icon>
      </div>
      <h2 class="title">{{ 'shell.incompatibleTitle' | transloco }}</h2>
      <p class="message">{{ 'shell.incompatibleMessage' | transloco: { version: serverVersion() } }}</p>
      <div class="actions">
        <button type="button" mat-flat-button color="primary" (click)="acknowledge()">
          {{ 'shell.incompatibleDismiss' | transloco }}
        </button>
      </div>
    </div>
  `,
  styles: [`
    .dialog {
      /* Center content inside the responsive modal card. */
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100%;
      box-sizing: border-box;
      padding: 28px 24px;
      text-align: center;
    }

    /* Tinted glyph circle — focal point that reads as a warning at a glance. Tinted from --app-warning
       (no dedicated -soft token exists) so light/dark both get a legible soft wash. */
    .badge {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 64px;
      height: 64px;
      border-radius: var(--app-radius-pill);
      background: color-mix(in srgb, var(--app-warning) 16%, transparent);
      color: var(--app-warning);
      margin-bottom: 16px;
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

    /* Single full-width acknowledge button — a real mat-flat-button so state layer, ripple, and theming
       come from Material. */
    .actions {
      display: flex;
      gap: 12px; /* integer gap */
      width: 100%;
      max-width: 360px;
    }
    .actions button {
      flex: 1 1 0;
    }
  `],
})
export class ShellIncompatibleDialogComponent {
  private readonly routeService = inject(RouteService);

  /** Exposed so the template can reference the fixed warning glyph (`AppIconType.REPORT`). */
  protected readonly AppIconType = AppIconType;
  /** The backend version the shell is incompatible with — interpolated into the message copy. */
  readonly serverVersion = input.required<string>();

  acknowledge(): void {
    this.routeService.closeDlg(undefined);
  }
}
