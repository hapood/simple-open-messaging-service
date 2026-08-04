import {
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { MatListModule } from '@angular/material/list';
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
import { PushService, type FcmProbeStatus } from '../../services/push.service';

/**
 * Settings → Push sub-page (Android/Tauri only). The FCM availability readout + "Check now" button, the
 * real-time foreground-service toggle, and the ~6h WorkManager poll toggle with its next scheduled time.
 * Moved verbatim from the old flat Settings page — logic unchanged, only relocated behind the category
 * drill-in. Body-only.
 */
@Component({
  selector: 'app-settings-push',
  imports: [
    MatListModule,
    MatSlideToggleModule,
    MatButtonModule,
    MatButtonToggleModule,
    TranslocoPipe,
  ],
  template: `
    <section class="settings-group">
      <div class="settings-card">
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

          <!-- FCM status (read-only) + manual "check now" -->
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.fcm' | transloco }}</span>
            <span matListItemLine class="hint">{{ fcmProbeHint() }}</span>
            <div matListItemMeta class="row-actions">
              <span
                class="status-pill"
                [class.active]="
                  probeStage() === 'device_received' ||
                  (!probeStage() && fcmActive())
                "
              >
                {{ fcmProbeStatusLabel() }}
              </span>
              <button
                mat-button
                type="button"
                class="check-btn"
                (click)="requestFcmCheck()"
                [disabled]="checking() || cooldownRemaining() > 0"
              >
                @if (checking()) {
                  {{ 'settings.fcmChecking' | transloco }}
                } @else if (cooldownRemaining() > 0) {
                  {{ cooldownRemaining() }}s
                } @else {
                  {{ 'settings.fcmCheckButton' | transloco }}
                }
              </button>
            </div>
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
      </div>
    </section>
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsPushComponent implements OnInit, OnDestroy {
  readonly bgSync = inject(BackgroundSyncService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  private readonly push = inject(PushService);

  /** True while a manual FCM check is in flight (the "Check" button shows a checking state). */
  readonly checking = signal(false);
  readonly probeStage = signal<FcmProbeStatus['stage'] | 'timeout' | null>(
    null,
  );
  readonly probeLatencyMs = signal<number | null>(null);
  readonly probeError = signal<string | null>(null);
  readonly cooldownRemaining = signal(0);
  private cooldownTimer: number | null = null;
  private destroyed = false;

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
  readonly fcmLastCheckLabel = computed(() => {
    void this.language.lang();
    const ms = this.bgSync.fcmStatus().lastCheck;
    if (!ms) return this.transloco.translate('settings.fcmNever');
    return this.transloco.translate('settings.fcmLastCheck', {
      time: dayjs(ms).format('MM-DD HH:mm'),
    });
  });
  readonly fcmProbeStatusLabel = computed(() => {
    void this.language.lang();
    const stage = this.probeStage();
    if (stage === 'device_received')
      return this.transloco.translate('settings.fcmProbeReceived');
    if (stage === 'fcm_accepted')
      return this.transloco.translate('settings.fcmProbeAccepted');
    if (stage === 'failed' || stage === 'timeout')
      return this.transloco.translate('settings.fcmProbeFailed');
    return this.fcmStatusLabel();
  });
  readonly fcmProbeHint = computed(() => {
    void this.language.lang();
    const stage = this.probeStage();
    if (stage === 'device_received') {
      return this.transloco.translate('settings.fcmProbeReceivedHint', {
        ms: this.probeLatencyMs() ?? 0,
      });
    }
    if (stage === 'fcm_accepted')
      return this.transloco.translate('settings.fcmProbeWaiting');
    if (stage === 'timeout')
      return this.transloco.translate('settings.fcmProbeTimeout');
    if (stage === 'failed') {
      return this.transloco.translate('settings.fcmProbeError', {
        error: this.probeError() ?? '',
      });
    }
    const local = this.bgSync.fcmStatus();
    if (!local.playServicesAvailable) {
      return this.transloco.translate('settings.fcmPlayServicesUnavailable', {
        status: local.playServicesStatus,
      });
    }
    if (local.tokenError) {
      return this.transloco.translate('settings.fcmTokenError', {
        error: local.tokenError,
      });
    }
    return this.fcmLastCheckLabel();
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

  /** Manual FCM availability check — force a token fetch + show a checking state until it settles. */
  async requestFcmCheck(): Promise<void> {
    if (this.checking() || this.cooldownRemaining() > 0) return;
    this.checking.set(true);
    this.probeStage.set(null);
    this.probeError.set(null);
    this.probeLatencyMs.set(null);
    this.startCooldown();
    this.bgSync.requestFcmCheck();
    try {
      const token = await this.waitForFcmToken();
      if (!token) {
        const local = this.bgSync.fcmStatus();
        const detail = !local.playServicesAvailable
          ? local.playServicesStatus
          : local.tokenError;
        throw new Error(
          detail || this.transloco.translate('settings.fcmProbeNoToken'),
        );
      }
      let status = await this.push.createFcmProbe(token);
      this.applyProbeStatus(status);
      if (status.stage === 'failed') return;
      const deadline = Date.now() + 15_000;
      while (!this.destroyed && Date.now() < deadline) {
        await this.delay(1_000);
        status = await this.push.getFcmProbe(status.probeId);
        this.applyProbeStatus(status);
        if (status.stage === 'device_received' || status.stage === 'failed')
          return;
      }
      if (!this.destroyed) this.probeStage.set('timeout');
    } catch (e) {
      if (!this.destroyed) {
        this.probeError.set(this.readProbeError(e));
        this.probeStage.set('failed');
      }
    } finally {
      if (!this.destroyed) this.checking.set(false);
    }
  }

  private async waitForFcmToken(): Promise<string | null> {
    for (let i = 0; i < 12; i += 1) {
      const token = window.SomsFcm?.getToken() ?? null;
      if (token) return token;
      await this.delay(250);
    }
    return null;
  }

  private applyProbeStatus(status: FcmProbeStatus): void {
    this.probeStage.set(status.stage);
    this.probeLatencyMs.set(status.latencyMs ?? null);
    this.probeError.set(status.errorCode ?? null);
  }

  private startCooldown(): void {
    this.cooldownRemaining.set(30);
    if (this.cooldownTimer !== null) window.clearInterval(this.cooldownTimer);
    this.cooldownTimer = window.setInterval(() => {
      const next = this.cooldownRemaining() - 1;
      this.cooldownRemaining.set(Math.max(0, next));
      if (next <= 0 && this.cooldownTimer !== null) {
        window.clearInterval(this.cooldownTimer);
        this.cooldownTimer = null;
      }
    }, 1_000);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private readProbeError(error: unknown): string {
    const e = error as { error?: { message?: string }; message?: string };
    return (
      e.error?.message ??
      e.message ??
      this.transloco.translate('settings.fcmProbeUnknownError')
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
    this.destroyed = true;
    if (this.cooldownTimer !== null) window.clearInterval(this.cooldownTimer);
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
