import {
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatCardModule } from '@angular/material/card';
import {
  MatSlideToggleModule,
  MatSlideToggleChange,
} from '@angular/material/slide-toggle';
import { MatButtonModule } from '@angular/material/button';
import {
  MatButtonToggleModule,
  MatButtonToggleChange,
} from '@angular/material/button-toggle';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import dayjs from 'dayjs';
import { BackgroundSyncService } from '../../services/background-sync.service';
import { LanguageService } from '../../services/language.service';
import { SettingsPushProbeComponent } from './settings-push-probe.component';

/**
 * Android push settings: local FCM availability, shared delivery diagnostics,
 * foreground keep-alive, and scheduled background synchronization.
 */
@Component({
  selector: 'app-settings-push',
  imports: [
    MatListModule,
    MatCardModule,
    MatSlideToggleModule,
    MatButtonModule,
    MatButtonToggleModule,
    TranslocoPipe,
    SettingsPushProbeComponent,
  ],
  template: `
    <section class="settings-group">
      <mat-card appearance="outlined" class="settings-card">
        <mat-list>
          <!-- System notification permission (the gate every delivery path below depends on) -->
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.notifPermTitle' | transloco
            }}</span>
            <span matListItemLine class="hint">{{ notifPermHint() }}</span>
            <div matListItemMeta class="row-actions">
              <span class="status-pill" [class.active]="notifEnabled()">{{
                notifPermStateLabel()
              }}</span>
              @if (!notifEnabled() && notifCanRequest()) {
                <button
                  mat-button
                  type="button"
                  class="check-btn"
                  (click)="requestNotifPermission()"
                >
                  {{ 'settings.notifPermAllow' | transloco }}
                </button>
              } @else if (!notifEnabled() && !notifCanRequest()) {
                <button
                  mat-button
                  type="button"
                  class="check-btn"
                  (click)="openNotifSettings()"
                >
                  {{ 'settings.notifPermOpenSettings' | transloco }}
                </button>
              }
            </div>
          </mat-list-item>

          <mat-list-item>
            <span matListItemTitle>{{
              'settings.notifAlertFrequency' | transloco
            }}</span>
            <span matListItemLine class="hint">{{
              'settings.notifAlertFrequencyDesc' | transloco
            }}</span>
            <div matListItemMeta>
              <mat-button-toggle-group
                [value]="bgSync.alertPolicy()"
                (change)="onAlertPolicyChange($event)"
                [attr.aria-label]="'settings.notifAlertFrequency' | transloco"
              >
                <mat-button-toggle value="cooldown_2s">{{
                  'settings.notifAlert2s' | transloco
                }}</mat-button-toggle>
                <mat-button-toggle value="cooldown_5s">{{
                  'settings.notifAlert5s' | transloco
                }}</mat-button-toggle>
                <mat-button-toggle value="once_per_thread">{{
                  'settings.notifAlertOnce' | transloco
                }}</mat-button-toggle>
              </mat-button-toggle-group>
            </div>
          </mat-list-item>

          <mat-list-item>
            <span matListItemTitle>{{ 'settings.fcm' | transloco }}</span>
            <span matListItemLine class="hint">{{ fcmStatusLabel() }}</span>
            <span matListItemLine class="hint">{{ fcmHint() }}</span>
          </mat-list-item>

          <!-- Foreground service (real-time keep-alive) -->
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.keepAliveFgs' | transloco
            }}</span>
            <span matListItemLine class="hint">{{
              'settings.keepAliveFgsDesc' | transloco
            }}</span>
            @if (fcmActive()) {
              <span matListItemLine class="hint hint-accent">{{
                'settings.fgsHintFcmActive' | transloco
              }}</span>
            }
            @if (!notifEnabled()) {
              <span matListItemLine class="hint hint-accent">{{
                'settings.notifPermFgsSuppressedHint' | transloco
              }}</span>
            }
            <mat-slide-toggle
              matListItemMeta
              [checked]="bgSync.fgsEnabled()"
              [attr.aria-label]="'settings.keepAliveFgs' | transloco"
              (change)="onFgsChange($event)"
            >
            </mat-slide-toggle>
          </mat-list-item>

          <!-- Periodic poll (~6h) + next scheduled time -->
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.keepAlivePoll' | transloco
            }}</span>
            <span matListItemLine class="hint">{{
              'settings.keepAlivePollDesc' | transloco
            }}</span>
            @if (bgSync.enabled() && nextPullLabel()) {
              <span matListItemLine class="hint">
                {{ 'settings.nextPullLabel' | transloco }}:
                {{
                  'settings.nextPullApprox'
                    | transloco: { time: nextPullLabel() }
                }}
              </span>
            }
            <mat-slide-toggle
              matListItemMeta
              [checked]="bgSync.enabled()"
              [attr.aria-label]="'settings.keepAlivePoll' | transloco"
              (change)="onPollChange($event)"
            >
            </mat-slide-toggle>
          </mat-list-item>

          <!-- Away-notification grouping: per-conversation cards (default) vs one folded card -->
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.notifGrouping' | transloco
            }}</span>
            <span matListItemLine class="hint">{{
              'settings.notifGroupingDesc' | transloco
            }}</span>
            <div matListItemMeta>
              <mat-button-toggle-group
                [value]="bgSync.previewMode()"
                (change)="onPreviewModeChange($event)"
                [attr.aria-label]="'settings.notifGrouping' | transloco"
              >
                <mat-button-toggle value="message">{{
                  'settings.notifGroupingThread' | transloco
                }}</mat-button-toggle>
                <mat-button-toggle value="private">{{
                  'settings.notifGroupingAll' | transloco
                }}</mat-button-toggle>
              </mat-button-toggle-group>
            </div>
          </mat-list-item>

          <!-- Sound & vibration: Android owns these at the channel level (pinned at creation), so the only
               in-app surface is a deep-link to the system per-channel settings. -->
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.notifSoundVibrate' | transloco
            }}</span>
            <span matListItemLine class="hint">{{
              'settings.notifSoundVibrateDesc' | transloco
            }}</span>
            <div matListItemMeta>
              <button mat-button type="button" (click)="openNotifSettings()">
                {{ 'settings.notifPermOpenSettings' | transloco }}
              </button>
            </div>
          </mat-list-item>
        </mat-list>
        <app-settings-push-probe />
      </mat-card>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './sub-page.scss',
})
export class SettingsPushComponent implements OnInit, OnDestroy {
  readonly bgSync = inject(BackgroundSyncService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  /** System notification permission, derived from BackgroundSyncService.notifStatus (refreshed on panel
   *  open + window focus, so a round-trip to system settings is reflected when the user returns). */
  readonly notifEnabled = computed(() => this.bgSync.notifStatus().enabled);
  readonly notifCanRequest = computed(
    () => this.bgSync.notifStatus().canRequest,
  );

  /** The status-pill label, varying with the permission state (translated; re-evaluated on language switch). */
  readonly notifPermStateLabel = computed(() => {
    void this.language.lang();
    const key = this.notifEnabled()
      ? 'settings.notifPermOn'
      : this.notifCanRequest()
        ? 'settings.notifPermOff'
        : 'settings.notifPermBlocked';
    return this.transloco.translate(key);
  });

  /** The hint line under the title, varying with the permission state (what to do next). */
  readonly notifPermHint = computed(() => {
    void this.language.lang();
    const key = this.notifEnabled()
      ? 'settings.notifPermGrantedHint'
      : this.notifCanRequest()
        ? 'settings.notifPermOffHint'
        : 'settings.notifPermBlockedHint';
    return this.transloco.translate(key);
  });

  /** True when FCM is active on this device — drives the "FGS not needed" hint on the FGS row. */
  readonly fcmActive = computed(() => this.bgSync.fcmStatus().hasToken);
  readonly fcmStatusLabel = computed(() => {
    void this.language.lang(); // re-evaluate on language switch
    return this.transloco.translate(
      this.fcmActive() ? 'settings.fcmActive' : 'settings.fcmUnavailable',
    );
  });
  readonly fcmHint = computed(() => {
    void this.language.lang();
    const local = this.bgSync.fcmStatus();
    if (!local.playServicesAvailable)
      return this.transloco.translate('settings.fcmPlayServicesUnavailable', {
        status: local.playServicesStatus,
      });
    if (local.tokenError)
      return this.transloco.translate('settings.fcmTokenError', {
        error: local.tokenError,
      });
    return local.lastCheck
      ? this.transloco.translate('settings.fcmLastCheck', {
          time: dayjs(local.lastCheck).format('MM-DD HH:mm'),
        })
      : this.transloco.translate('settings.fcmNever');
  });

  /** Next WorkManager pull time, formatted. Empty when not scheduled. */
  readonly nextPullLabel = computed(() => {
    void this.bgSync.enabled(); // re-evaluate when the poll toggle flips
    const t = this.bgSync.nextPullTime();
    return t > 0 ? dayjs(t).format('HH:mm') : '';
  });

  onPollChange(e: MatSlideToggleChange): void {
    this.bgSync.setEnabled(e.checked);
  }

  onFgsChange(e: MatSlideToggleChange): void {
    this.bgSync.setFgsEnabled(e.checked);
  }

  /** Away-notification grouping — per-conversation ("thread") vs one folded card ("all"). Persists to
   *  SomsSecureStore; the next background fetch sends it as `grouping`. */
  onPreviewModeChange(e: MatButtonToggleChange): void {
    this.bgSync.setPreviewMode(e.value as 'message' | 'private');
  }

  onAlertPolicyChange(e: MatButtonToggleChange): void {
    this.bgSync.setAlertPolicy(
      e.value as 'cooldown_2s' | 'cooldown_5s' | 'once_per_thread',
    );
  }

  /** Fire the system POST_NOTIFICATIONS prompt (only shown when canRequest — see the template guard). */
  requestNotifPermission(): void {
    this.bgSync.requestPermission();
  }

  /** Open the system per-app notification settings (the manual path when canRequest is false). */
  openNotifSettings(): void {
    this.bgSync.openSystemSettings();
  }

  /** Fresh read on panel open + on every window focus (the user returns from system settings with a
   *  changed toggle). Zoneless CD is driven by the signal write inside refreshNotifStatus, so no NgZone. */
  ngOnInit(): void {
    this.bgSync.refreshNotifStatus();
    window.addEventListener('focus', this.onFocusRefresh, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibilityRefresh, {
      passive: true,
    });
  }

  ngOnDestroy(): void {
    window.removeEventListener('focus', this.onFocusRefresh);
    document.removeEventListener('visibilitychange', this.onVisibilityRefresh);
  }

  private readonly onFocusRefresh = (): void =>
    this.bgSync.refreshNotifStatus();
  private readonly onVisibilityRefresh = (): void => {
    if (document.visibilityState === 'visible')
      this.bgSync.refreshNotifStatus();
  };
}
