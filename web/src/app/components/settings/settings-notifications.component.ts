import { Component, computed, inject } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatSlideToggleModule, MatSlideToggleChange } from '@angular/material/slide-toggle';
import { TranslocoPipe } from '@jsverse/transloco';
import { WebPushService } from '../../services/web-push.service';

/**
 * Settings → Notifications sub-page (browser build only — the category is visible when `!isTauri()`).
 * The single control is the browser notification permission, which the app can only ever REQUEST — a
 * one-way enable: `Notification.requestPermission()` has no API to revoke, so once granted only the
 * browser's site settings can undo it. The toggle reflects that honestly:
 *
 *  - `default`  → unchecked, clickable. Flipping it on calls {@link WebPushService.enable}, which
 *                 triggers the permission prompt (this is the user-gesture path browsers require) and,
 *                 on grant, subscribes Web Push for closed-tab delivery.
 *  - `granted`  → checked, LOCKED. The hint points to the browser's site settings to revoke.
 *  - `denied`   → unchecked, LOCKED. The hint explains the user must re-allow it in site settings.
 *  - `unsupported` (plain-HTTP origin / no Notification API) → no toggle, just a "requires HTTPS" hint.
 *
 * The permission state is reactive ({@link WebPushService.permission} refreshes on window focus), so the
 * toggle + hint track changes the user makes in the browser's site settings without a reload.
 */
@Component({
  selector: 'app-settings-notifications',
  imports: [MatListModule, MatSlideToggleModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.notifications' | transloco }}</span>
            <span matListItemLine class="hint">{{ hintKey() | transloco }}</span>
            @if (supported()) {
              <mat-slide-toggle
                [checked]="granted()"
                [disabled]="locked()"
                [attr.aria-label]="'settings.notifications' | transloco"
                (change)="onChange($event)">
              </mat-slide-toggle>
            }
          </mat-list-item>
        </mat-list>
      </div>
    </section>
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsNotificationsComponent {
  readonly webPush = inject(WebPushService);

  private readonly permission = this.webPush.permission;
  /** Notification API present (a secure context). When false the row shows an "unsupported" hint only. */
  readonly supported = computed(() => this.permission() !== 'unsupported');
  readonly granted = computed(() => this.permission() === 'granted');
  /** The toggle is only interactive from `default` — the one state the app can act in. Granted/denied
   *  are terminal from the app's side (only browser site settings can move them), so it locks there. */
  readonly locked = computed(() => this.permission() !== 'default');

  /** The hint line under the title, varying with the current permission state. */
  readonly hintKey = computed<string>(() => {
    switch (this.permission()) {
      case 'granted':
        return 'settings.notifGrantedHint';
      case 'denied':
        return 'settings.notifDeniedHint';
      case 'unsupported':
        return 'settings.notifUnsupportedHint';
      default:
        return 'settings.notifDesc'; // 'default'
    }
  });

  /** Toggle flipped on (only reachable from `default` — it's locked otherwise). Fire the gesture-gated
   *  permission request; the resulting permission flows back through the signal and re-renders the row. */
  async onChange(e: MatSlideToggleChange): Promise<void> {
    if (e.checked) await this.webPush.enable();
  }
}
