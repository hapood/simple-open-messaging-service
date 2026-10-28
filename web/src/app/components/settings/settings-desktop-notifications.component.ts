import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatCardModule } from '@angular/material/card';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { TranslocoPipe } from '@jsverse/transloco';
import { NotificationPrefsService } from '../../services/notification-prefs.service';
import { tauriInvoke } from '../../services/runtime';

type Permission =
  | 'unsupported'
  | 'notDetermined'
  | 'denied'
  | 'authorized'
  | 'provisional'
  | 'unknown';

/** Native desktop settings never use browser notification permissions or Web Push. */
@Component({
  selector: 'app-settings-desktop-notifications',
  imports: [
    MatButtonModule,
    MatListModule,
    MatCardModule,
    MatSlideToggleModule,
    MatButtonToggleModule,
    TranslocoPipe,
  ],
  template: `
    <section class="settings-group">
      <mat-card appearance="outlined" class="settings-card">
        <mat-list>
          @if (permission() !== 'unsupported') {
            <mat-list-item>
              <span matListItemTitle>{{
                'settings.nativeNotifPermission' | transloco
              }}</span>
              <span matListItemLine class="hint">{{
                permissionKey() | transloco
              }}</span>
              @if (permission() === 'notDetermined') {
                <button
                  matListItemMeta
                  mat-button
                  [disabled]="busy()"
                  (click)="requestPermission()"
                >
                  {{ 'settings.nativeNotifAuthorize' | transloco }}
                </button>
              } @else if (permission() && permission() !== 'unknown') {
                <button
                  matListItemMeta
                  mat-button
                  [disabled]="busy()"
                  (click)="openSettings()"
                >
                  {{ 'settings.nativeNotifOpenSettings' | transloco }}
                </button>
              } @else {
                <button
                  matListItemMeta
                  mat-button
                  [disabled]="busy()"
                  (click)="refresh()"
                >
                  {{ 'settings.nativeNotifRefresh' | transloco }}
                </button>
              }
            </mat-list-item>
          }
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.notifDesktop' | transloco
            }}</span>
            <span matListItemLine class="hint">{{
              'settings.nativeNotifDesktopDesc' | transloco
            }}</span>
            <mat-slide-toggle
              matListItemMeta
              [checked]="prefs.enabled()"
              [attr.aria-label]="'settings.notifDesktop' | transloco"
              (change)="prefs.setEnabled($event.checked)"
            />
          </mat-list-item>
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.notifSound' | transloco
            }}</span>
            <span matListItemLine class="hint">{{
              'settings.notifSoundDesc' | transloco
            }}</span>
            <mat-slide-toggle
              matListItemMeta
              [checked]="prefs.sound()"
              [disabled]="!prefs.enabled()"
              [attr.aria-label]="'settings.notifSound' | transloco"
              (change)="prefs.setSound($event.checked)"
            />
          </mat-list-item>
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.notifGrouping' | transloco
            }}</span>
            <span matListItemLine class="hint">{{
              'settings.notifGroupingDesc' | transloco
            }}</span>
            <mat-button-toggle-group
              matListItemMeta
              [value]="prefs.previewMode()"
              [disabled]="!prefs.enabled()"
              [attr.aria-label]="'settings.notifGrouping' | transloco"
              (change)="setPreviewMode($event.value)"
            >
              <mat-button-toggle value="message">{{
                'settings.notifGroupingThread' | transloco
              }}</mat-button-toggle>
              <mat-button-toggle value="private">{{
                'settings.notifGroupingAll' | transloco
              }}</mat-button-toggle>
            </mat-button-toggle-group>
          </mat-list-item>
        </mat-list>
        <p class="hint">{{ 'settings.nativeNotifRuntimeHint' | transloco }}</p>
        @if (failed()) {
          <p class="hint" role="alert">
            {{ 'settings.nativeNotifError' | transloco }}
          </p>
        }
      </mat-card>
    </section>
  `,
  styleUrl: './sub-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsDesktopNotificationsComponent {
  readonly prefs = inject(NotificationPrefsService);
  readonly permission = signal<Permission | null>(null);
  readonly busy = signal(false);
  readonly failed = signal(false);
  private destroyed = false;
  private revision = 0;

  constructor() {
    const refresh = () => void this.refresh();
    window.addEventListener('focus', refresh);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.revision++;
      window.removeEventListener('focus', refresh);
    });
    void this.refresh();
  }

  permissionKey(): string {
    const state = this.permission();
    return state
      ? `settings.nativeNotifPermission_${state}`
      : 'settings.nativeNotifLoading';
  }

  async refresh(): Promise<void> {
    if (this.busy() || this.destroyed) return;
    await this.run('desktop_notification_permission', true);
  }

  async requestPermission(): Promise<void> {
    if (this.busy() || this.destroyed || this.permission() !== 'notDetermined')
      return;
    await this.run('desktop_notification_request_permission', true);
  }

  async openSettings(): Promise<void> {
    if (this.busy() || this.destroyed) return;
    await this.run('desktop_notification_open_settings', false);
  }

  setPreviewMode(mode: unknown): void {
    if (mode === 'message' || mode === 'private')
      this.prefs.setPreviewMode(mode);
  }

  private async run(command: string, readsPermission: boolean): Promise<void> {
    const revision = ++this.revision;
    this.busy.set(true);
    this.failed.set(false);
    try {
      const result = await tauriInvoke<Permission | void>(command);
      if (this.destroyed || revision !== this.revision) return;
      if (readsPermission) {
        const known: Permission[] = [
          'unsupported',
          'notDetermined',
          'denied',
          'authorized',
          'provisional',
          'unknown',
        ];
        this.permission.set(
          result && known.includes(result) ? result : 'unknown',
        );
      }
    } catch {
      if (!this.destroyed && revision === this.revision) {
        this.failed.set(true);
        if (readsPermission && this.permission() === null)
          this.permission.set('unknown');
      }
    } finally {
      if (!this.destroyed && revision === this.revision) this.busy.set(false);
    }
  }
}
