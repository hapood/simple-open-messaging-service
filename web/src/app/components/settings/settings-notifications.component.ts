import { Component, computed, inject } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatSlideToggleModule, MatSlideToggleChange } from '@angular/material/slide-toggle';
import { MatButtonToggleModule, MatButtonToggleChange } from '@angular/material/button-toggle';
import { TranslocoPipe } from '@jsverse/transloco';
import { WebPushService } from '../../services/web-push.service';
import { NotificationPrefsService } from '../../services/notification-prefs.service';

/**
 * Settings → Notifications sub-page (browser build only — the category is visible when `!isTauri()`).
 *
 * The first row grants the browser notification permission. The instant that's granted,
 * {@link UnreadAttentionService} posts a SINGLE rolling summary notification — "Alice, Bob sent you N
 * messages" — that replaces itself (shared tag, never stacks) on each new background
 * message and is dismissed when the tab regains focus. No message content/preview is shown, only the
 * sender + count summary. The permission row reflects the browser permission:
 *
 *  - `default`  → unchecked, clickable. Flipping it on calls {@link WebPushService.enable}, which fires
 *                 the permission prompt (the user-gesture path browsers require) and, on grant, LOCAL
 *                 notifications go live. Server-side Web Push (closed-tab delivery) is attempted as a
 *                 silent best-effort bonus on top.
 *  - `granted`  → checked, LOCKED. Local notifications are on. `Notification.requestPermission()` has no
 *                 revoke API, so only the browser's site settings can turn it off — the hint says so.
 *  - `denied`   → unchecked, LOCKED. The hint explains the user must re-allow it in site settings.
 *  - `unsupported` (plain-HTTP origin / no Notification API) → no toggle, just a "requires HTTPS" hint.
 *
 * When `granted`, two app-level toggles appear beneath it ({@link NotificationPrefsService}, persisted to
 * localStorage) — the in-app controls the browser permission can't offer: "Show desktop alerts" (mute
 * posting entirely) and "Sound" (`silent: !sound`). The permission state is reactive
 * ({@link WebPushService.permission} refreshes on window focus), so the rows track changes the user makes
 * in the browser's site settings without a reload.
 */
@Component({
  selector: 'app-settings-notifications',
  imports: [MatListModule, MatSlideToggleModule, MatButtonToggleModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.notifications' | transloco }}</span>
            <span matListItemLine class="hint">{{ hintKey() | transloco }}</span>
            @if (supported()) {
              <mat-slide-toggle
                matListItemMeta
                [checked]="granted()"
                [disabled]="locked()"
                [attr.aria-label]="'settings.notifications' | transloco"
                (change)="onChange($event)">
              </mat-slide-toggle>
            }
          </mat-list-item>

          @if (granted()) {
            <!-- App-level master: post the system notification at all (the browser permission above is
                 terminal; this is the in-app mute). -->
            <mat-list-item>
              <span matListItemTitle>{{ 'settings.notifDesktop' | transloco }}</span>
              <span matListItemLine class="hint">{{ 'settings.notifDesktopDesc' | transloco }}</span>
              <mat-slide-toggle
                matListItemMeta
                [checked]="prefs.enabled()"
                [attr.aria-label]="'settings.notifDesktop' | transloco"
                (change)="onDesktopChange($event)">
              </mat-slide-toggle>
            </mat-list-item>

            <!-- Sound on/off (moot when desktop alerts are off, so it locks then). -->
            <mat-list-item>
              <span matListItemTitle>{{ 'settings.notifSound' | transloco }}</span>
              <span matListItemLine class="hint">{{ 'settings.notifSoundDesc' | transloco }}</span>
              <mat-slide-toggle
                matListItemMeta
                [checked]="prefs.sound()"
                [disabled]="!prefs.enabled()"
                [attr.aria-label]="'settings.notifSound' | transloco"
                (change)="onSoundChange($event)">
              </mat-slide-toggle>
            </mat-list-item>

            <!-- Away-notification grouping: per-conversation cards (default) vs one folded card -->
            <mat-list-item>
              <span matListItemTitle>{{ 'settings.notifGrouping' | transloco }}</span>
              <span matListItemLine class="hint">{{ 'settings.notifGroupingDesc' | transloco }}</span>
              <div matListItemMeta>
                <mat-button-toggle-group
                  [value]="prefs.previewMode()"
                  (change)="onPreviewModeChange($event)"
                  [attr.aria-label]="'settings.notifGrouping' | transloco">
                  <mat-button-toggle value="message">{{ 'settings.notifGroupingThread' | transloco }}</mat-button-toggle>
                  <mat-button-toggle value="private">{{ 'settings.notifGroupingAll' | transloco }}</mat-button-toggle>
                </mat-button-toggle-group>
              </div>
            </mat-list-item>
          }
        </mat-list>
      </div>
    </section>
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsNotificationsComponent {
  readonly webPush = inject(WebPushService);
  /** App-level notification preferences (show desktop alert / sound) — the in-app mute beneath the
   *  terminal browser-permission grant above. */
  readonly prefs = inject(NotificationPrefsService);

  private readonly permission = this.webPush.permission;
  /** Notification API present (a secure context). When false the row shows an "unsupported" hint only. */
  readonly supported = computed(() => this.permission() !== 'unsupported');
  /** Toggle checked = the browser permission is granted, i.e. LOCAL notifications are active. */
  readonly granted = computed(() => this.permission() === 'granted');
  /** The toggle is only interactive from `default` — the one state the app can act in. `granted`/`denied`
   *  are terminal from the app's side (`requestPermission` has no revoke; only browser site settings can
   *  move them), so it locks there. Nothing fails once granted — local notifications just work — so there
   *  is no "stuck, can't retry" state. */
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

  /** App-level "show desktop alert" mute (no browser-permission round-trip — persists to localStorage). */
  onDesktopChange(e: MatSlideToggleChange): void {
    this.prefs.setEnabled(e.checked);
  }

  /** Sound on/off — persists to localStorage; maps to `silent: !sound` on the posted Notification. */
  onSoundChange(e: MatSlideToggleChange): void {
    this.prefs.setSound(e.checked);
  }

  /** Away-notification grouping — persists to localStorage; the next foreground pull sends it as `grouping`. */
  onPreviewModeChange(e: MatButtonToggleChange): void {
    this.prefs.setPreviewMode(e.value as 'message' | 'private');
  }
}
