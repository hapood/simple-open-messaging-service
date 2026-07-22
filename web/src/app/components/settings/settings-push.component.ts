import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatSlideToggleModule, MatSlideToggleChange } from '@angular/material/slide-toggle';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule, MatButtonToggleChange } from '@angular/material/button-toggle';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import dayjs from 'dayjs';
import { BackgroundSyncService } from '../../services/background-sync.service';
import { LanguageService } from '../../services/language.service';

/**
 * Settings → Push sub-page (Android/Tauri only). The FCM availability readout + "Check now" button, the
 * real-time foreground-service toggle, and the ~6h WorkManager poll toggle with its next scheduled time.
 * Moved verbatim from the old flat Settings page — logic unchanged, only relocated behind the category
 * drill-in. Body-only.
 */
@Component({
  selector: 'app-settings-push',
  imports: [MatListModule, MatSlideToggleModule, MatButtonModule, MatButtonToggleModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          <!-- System notification permission (the gate every delivery path below depends on) -->
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.notifPermTitle' | transloco }}</span>
            <span matListItemLine class="hint">{{ notifPermHint() }}</span>
            <div matListItemMeta class="row-actions">
              <span class="status-pill" [class.active]="notifEnabled()">{{ notifPermStateLabel() }}</span>
              @if (!notifEnabled() && notifCanRequest()) {
                <button mat-button type="button" class="check-btn" (click)="requestNotifPermission()">
                  {{ 'settings.notifPermAllow' | transloco }}
                </button>
              } @else if (!notifEnabled() && !notifCanRequest()) {
                <button mat-button type="button" class="check-btn" (click)="openNotifSettings()">
                  {{ 'settings.notifPermOpenSettings' | transloco }}
                </button>
              }
            </div>
          </mat-list-item>

          <!-- FCM status (read-only) + manual "check now" -->
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.fcm' | transloco }}</span>
            <span matListItemLine class="hint">{{ fcmLastCheckLabel() }}</span>
            <div matListItemMeta class="row-actions">
              <span class="status-pill" [class.active]="fcmActive()">{{ fcmStatusLabel() }}</span>
              <button mat-button type="button" class="check-btn" (click)="requestFcmCheck()"
                [disabled]="checking()">
                {{ (checking() ? 'settings.fcmChecking' : 'settings.fcmCheckButton') | transloco }}
              </button>
            </div>
          </mat-list-item>

          <!-- Foreground service (real-time keep-alive) -->
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.keepAliveFgs' | transloco }}</span>
            <span matListItemLine class="hint">{{ 'settings.keepAliveFgsDesc' | transloco }}</span>
            @if (fcmActive()) {
              <span matListItemLine class="hint hint-accent">{{ 'settings.fgsHintFcmActive' | transloco }}</span>
            }
            @if (!notifEnabled()) {
              <span matListItemLine class="hint hint-accent">{{ 'settings.notifPermFgsSuppressedHint' | transloco }}</span>
            }
            <mat-slide-toggle
              matListItemMeta
              [checked]="bgSync.fgsEnabled()"
              [attr.aria-label]="'settings.keepAliveFgs' | transloco"
              (change)="onFgsChange($event)">
            </mat-slide-toggle>
          </mat-list-item>

          <!-- Periodic poll (~6h) + next scheduled time -->
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.keepAlivePoll' | transloco }}</span>
            <span matListItemLine class="hint">{{ 'settings.keepAlivePollDesc' | transloco }}</span>
            @if (bgSync.enabled() && nextPullLabel()) {
              <span matListItemLine class="hint">
                {{ 'settings.nextPullLabel' | transloco }}:
                {{ 'settings.nextPullApprox' | transloco: { time: nextPullLabel() } }}
              </span>
            }
            <mat-slide-toggle
              matListItemMeta
              [checked]="bgSync.enabled()"
              [attr.aria-label]="'settings.keepAlivePoll' | transloco"
              (change)="onPollChange($event)">
            </mat-slide-toggle>
          </mat-list-item>

          <!-- Away-notification grouping: per-conversation cards (default) vs one folded card -->
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.notifGrouping' | transloco }}</span>
            <span matListItemLine class="hint">{{ 'settings.notifGroupingDesc' | transloco }}</span>
            <div matListItemMeta>
              <mat-button-toggle-group
                [value]="bgSync.grouping()"
                (change)="onGroupingChange($event)"
                [attr.aria-label]="'settings.notifGrouping' | transloco">
                <mat-button-toggle value="thread">{{ 'settings.notifGroupingThread' | transloco }}</mat-button-toggle>
                <mat-button-toggle value="all">{{ 'settings.notifGroupingAll' | transloco }}</mat-button-toggle>
              </mat-button-toggle-group>
            </div>
          </mat-list-item>

          <!-- Sound & vibration: Android owns these at the channel level (pinned at creation), so the only
               in-app surface is a deep-link to the system per-channel settings. -->
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.notifSoundVibrate' | transloco }}</span>
            <span matListItemLine class="hint">{{ 'settings.notifSoundVibrateDesc' | transloco }}</span>
            <div matListItemMeta>
              <button mat-button type="button" (click)="openNotifSettings()">
                {{ 'settings.notifPermOpenSettings' | transloco }}
              </button>
            </div>
          </mat-list-item>
        </mat-list>
      </div>
    </section>
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsPushComponent implements OnInit, OnDestroy {
  readonly bgSync = inject(BackgroundSyncService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  /** True while a manual FCM check is in flight (the "Check" button shows a checking state). */
  readonly checking = signal(false);

  /** System notification permission, derived from BackgroundSyncService.notifStatus (refreshed on panel
   *  open + window focus, so a round-trip to system settings is reflected when the user returns). */
  readonly notifEnabled = computed(() => this.bgSync.notifStatus().enabled);
  readonly notifCanRequest = computed(() => this.bgSync.notifStatus().canRequest);

  /** The status-pill label, varying with the permission state (translated; re-evaluated on language switch). */
  readonly notifPermStateLabel = computed(() => {
    void this.language.lang();
    const key = this.notifEnabled() ? 'settings.notifPermOn'
      : this.notifCanRequest() ? 'settings.notifPermOff' : 'settings.notifPermBlocked';
    return this.transloco.translate(key);
  });

  /** The hint line under the title, varying with the permission state (what to do next). */
  readonly notifPermHint = computed(() => {
    void this.language.lang();
    const key = this.notifEnabled() ? 'settings.notifPermGrantedHint'
      : this.notifCanRequest() ? 'settings.notifPermOffHint' : 'settings.notifPermBlockedHint';
    return this.transloco.translate(key);
  });

  /** True when FCM is active on this device — drives the "FGS not needed" hint on the FGS row. */
  readonly fcmActive = computed(() => this.bgSync.fcmStatus().hasToken);
  readonly fcmStatusLabel = computed(() => {
    void this.language.lang(); // re-evaluate on language switch
    return this.transloco.translate(this.fcmActive() ? 'settings.fcmActive' : 'settings.fcmUnavailable');
  });
  readonly fcmLastCheckLabel = computed(() => {
    void this.language.lang();
    const ms = this.bgSync.fcmStatus().lastCheck;
    if (!ms) return this.transloco.translate('settings.fcmNever');
    return this.transloco.translate('settings.fcmLastCheck', { time: dayjs(ms).format('MM-DD HH:mm') });
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
  onGroupingChange(e: MatButtonToggleChange): void {
    this.bgSync.setGrouping(e.value as 'all' | 'thread');
  }

  /** Manual FCM availability check — force a token fetch + show a checking state until it settles. */
  requestFcmCheck(): void {
    this.checking.set(true);
    this.bgSync.requestFcmCheck();
    // Match BackgroundSyncService's re-read delay; the token fetch + emit lands around then.
    window.setTimeout(() => this.checking.set(false), 2700);
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
    document.addEventListener('visibilitychange', this.onVisibilityRefresh, { passive: true });
  }

  ngOnDestroy(): void {
    window.removeEventListener('focus', this.onFocusRefresh);
    document.removeEventListener('visibilitychange', this.onVisibilityRefresh);
  }

  private readonly onFocusRefresh = (): void => this.bgSync.refreshNotifStatus();
  private readonly onVisibilityRefresh = (): void => {
    if (document.visibilityState === 'visible') this.bgSync.refreshNotifStatus();
  };
}
