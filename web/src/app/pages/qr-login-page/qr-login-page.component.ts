import { Component, signal, computed, inject, OnDestroy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { QrCodeComponent } from '../../components/qr-code/qr-code.component';
import { AuthService } from '../../services/auth.service';
import { ConfigService } from '../../services/config.service';
import { RouteService, RoutePage } from '../../services/route.service';
import { isTauri, sessionClient } from '../../services/runtime';

type QrView = 'loading' | 'pending' | 'scanned' | 'expired';

/**
 * QR-scan login page (every platform). Mints a sign-in token (rendered as a QR for an already-logged-in
 * phone to scan), polls its status, and — once the phone confirms — activates a session whose lifetime
 * follows the platform's trust: permanent on the trusted native clients (Android app / desktop with a
 * working keyring), 14-day sliding on the browser (which also shows an extra notice about that limit).
 * Reached automatically from `/auth/login` under APP_OTP_AND_QR mode; on Android it is switchable with OTP.
 *
 * The QR image is rendered by {@link QrCodeComponent} (uqr matrix → SVG); the phone-side scan + confirm is
 * the two-step "Link a device" flow under Settings → Devices (the Tauri barcode-scanner plugin, Android
 * only). The backend round-trip (create → poll → scan → confirm) is fully wired here and on the server.
 * The sole outstanding item is an on-device APK smoke of the scanner; this render + poll path is complete.
 */
@Component({
  selector: 'app-qr-login-page',
  imports: [
    AuthBrandComponent,
    AuthToolbarComponent,
    IconComponent,
    QrCodeComponent,
    TranslocoPipe,
    MatButtonModule,
    MatProgressBarModule,
    RouterLink,
  ],
  templateUrl: './qr-login-page.component.html',
  styleUrl: './qr-login-page.component.scss',
})
export class QrLoginPageComponent implements OnDestroy {
  protected readonly isTauri = isTauri;
  protected readonly AppIcon = AppIconType;
  private readonly auth = inject(AuthService);
  private readonly config = inject(ConfigService);
  private readonly routeService = inject(RouteService);

  qrToken = signal<string | null>(null);
  view = signal<QrView>('loading');
  /** Remaining-time fraction of the current QR token for the determinate countdown bar: 100 just after the
   *  token is minted, depleting linearly to 0 exactly at the backend's `expiresAt`. Bound to a determinate
   *  progress bar in the 'pending' state so the user sees the code running out, instead of an indeterminate
   *  spinner that implies work the idle wait isn't doing. */
  readonly qrRemainingPct = signal(100);
  /** Whole seconds left on the current QR token, mirrored from the countdown tick at second resolution so
   *  the template can render a stable `m:ss` without reformatting on every 250ms tick. */
  readonly qrRemainingSec = signal(0);
  /** `m:ss` countdown text (e.g. "2:59"), shown beside the determinate bar while pending. */
  readonly qrRemainingText = computed(() => {
    const sec = this.qrRemainingSec();
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  });
  /** Permanent-session trust for THIS QR: a trusted native client (Android app / desktop — both keep the
   *  token in OS secure storage) gets a permanent session; the browser gets a 14-day sliding one. The
   *  platform is the trust signal (no opt-in toggle). Drives the session lifetime + the notice shown. */
  readonly qrTrusted = isTauri();
  readonly canPassword = computed(() => this.config.methodsForPlatform().includes('password'));
  /** OTP login is offered as a switcher when enabled — always so under the alt modes (both methods on every
   *  platform). */
  readonly canOtp = computed(() => this.config.methodsForPlatform().includes('otp'));

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private countdownTimer: ReturnType<typeof setInterval> | undefined;
  /** Absolute deadline (epoch ms) and full TTL of the current QR token, captured at mint. `expiresAt` is
   *  absolute, so dividing the remaining time by the TTL yields the linear 0–100 bar bound above. */
  private qrDeadline = 0;
  private qrTotalMs = 1;

  constructor() {
    void this.config.ensureLoaded();
    this.start();
  }

  ngOnDestroy(): void {
    this.stopPoll();
    this.stopCountdown();
  }

  private start(): void {
    this.stopCountdown();
    this.view.set('loading');
    // client follows the real platform (app/web/desktop) and trust follows the platform's capability —
    // both are constant for this app session, so the QR is minted once at the right level (no toggle).
    this.auth.qrCreate(sessionClient(), this.qrTrusted).subscribe({
      next: (res) => {
        if (res.code === 0 && res.data) {
          this.qrToken.set(res.data.qrToken);
          this.qrDeadline = res.data.expiresAt;
          this.qrTotalMs = Math.max(1, res.data.expiresAt - Date.now());
          this.qrRemainingPct.set(100);
          this.qrRemainingSec.set(Math.ceil(this.qrTotalMs / 1000));
          this.view.set('pending');
          this.beginCountdown();
          this.beginPoll();
        } else {
          this.view.set('expired');
        }
      },
      error: () => this.view.set('expired'),
    });
  }

  private beginPoll(): void {
    const token = this.qrToken();
    if (!token) return;
    this.stopPoll();
    this.pollTimer = setInterval(() => {
      this.auth.qrPoll(token, undefined, this.qrTrusted).subscribe({
        next: (res) => {
          if (res.code === 0 && res.data?.session_token) {
            this.stopPoll();
            this.routeService.redirect(
              res.data?.mustChangePassword ? RoutePage.AUTH_SET_PASSWORD : RoutePage.HOME,
            );
          } else if (res.code === 0 && res.data?.status === 'scanned') {
            // The token is consumed once scanned — the countdown is meaningless while the phone confirms.
            this.stopCountdown();
            this.view.set('scanned');
          } else if (res.code === 0 && res.data?.status === 'expired') {
            this.stopPoll();
            this.stopCountdown();
            this.view.set('expired');
          }
        },
        // A transient poll error doesn't abort the flow — the next tick retries.
        error: () => {},
      });
    }, 1500);
  }

  private stopPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** Animate the determinate countdown bar from the mint deadline. A 250ms tick shifts the fill by a
   *  sub-pixel sliver on the card width, so it reads as continuous without a CSS transition reaching into
   *  Material's bar internals (fragile across versions). */
  private beginCountdown(): void {
    this.stopCountdown();
    this.tickCountdown();
    this.countdownTimer = setInterval(() => this.tickCountdown(), 250);
  }

  private tickCountdown(): void {
    const remaining = this.qrDeadline - Date.now();
    if (remaining <= 0) {
      // The deadline is the source of truth for expiry — don't wait up to 1.5s for the next poll to say so.
      this.qrRemainingPct.set(0);
      this.qrRemainingSec.set(0);
      this.stopPoll();
      this.stopCountdown();
      this.view.set('expired');
      return;
    }
    this.qrRemainingPct.set(Math.min(100, (remaining / this.qrTotalMs) * 100));
    this.qrRemainingSec.set(Math.ceil(remaining / 1000));
  }

  private stopCountdown(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = undefined;
  }

  /** Refresh: mint a fresh sign-in token after an expiry. */
  retry(): void {
    this.stopPoll();
    this.qrToken.set(null);
    this.start();
  }

  jumpToPassword(): void {
    // replaceUrl: switching login methods must not stack entries (the clean-history contract).
    this.routeService.redirect(RoutePage.AUTH_LOGIN);
  }

  jumpToOtp(): void {
    // replaceUrl: switching login methods must not stack entries (the clean-history contract).
    this.routeService.redirect(RoutePage.AUTH_OTP);
  }
}
