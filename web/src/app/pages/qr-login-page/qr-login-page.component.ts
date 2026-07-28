import { Component, signal, computed, inject, OnDestroy, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { QrCodeComponent } from '../../components/qr-code/qr-code.component';
import { AuthService } from '../../services/auth.service';
import { ConfigService } from '../../services/config.service';
import { RouteService, RoutePage } from '../../services/route.service';
import { isTauri, sessionClient } from '../../services/runtime';
import { AuthViewportDirective } from '../../directives/auth-viewport.directive';
import { AuthMethodMenuComponent } from '../../components/auth-method-menu/auth-method-menu.component';

type QrView = 'loading' | 'pending' | 'scanned' | 'error';

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
 *
 * Expiry is NOT a dead end: a normal TTL run-out silently mints a fresh code (the loading spinner shows in
 * the QR square meanwhile), so the user never lands on a manual "refresh" button just because they were
 * slow to scan. Only a genuine run of qrCreate failures (network drop) falls through to a recoverable
 * error state with a retry button — transient blips self-heal via bounded backoff first.
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
    MatProgressSpinnerModule,
    RouterLink,
    AuthViewportDirective,
    AuthMethodMenuComponent,
  ],
  templateUrl: './qr-login-page.component.html',
  styleUrl: './qr-login-page.component.scss',
})
export class QrLoginPageComponent implements OnDestroy {
  protected readonly isTauri = isTauri;
  protected readonly AppIcon = AppIconType;
  /** Seconds-under-which the determinate bar flips to the danger color. The QR's 3-min TTL makes 15s the
   *  last ~8% — late enough not to cry wolf on a fresh code, early enough to signal "scan soon or it
   *  refreshes". The bar's color is the only expiry cue now that the m:ss readout was dropped. */
  protected readonly QR_WARN_SEC = 15;
  private readonly auth = inject(AuthService);
  private readonly config = inject(ConfigService);
  private readonly routeService = inject(RouteService);
  /** Piped onto every qrCreate/qrPoll subscription so an in-flight response can't fire its `next` on a
   *  destroyed component (which would re-create poll/countdown intervals that ngOnDestroy already missed). */
  private readonly destroyRef = inject(DestroyRef);

  qrToken = signal<string | null>(null);
  view = signal<QrView>('loading');
  /** Remaining-time fraction of the current QR token for the determinate countdown bar: 100 just after the
   *  token is minted, depleting linearly to 0 exactly at the backend's `expiresAt`. Bound to a determinate
   *  progress bar in the 'pending' state so the user sees the code running out, instead of an indeterminate
   *  spinner that implies work the idle wait isn't doing. */
  readonly qrRemainingPct = signal(100);
  /** Whole seconds left on the current QR token, mirrored from the countdown tick at second resolution.
   *  Not rendered as text anymore — it drives the determinate bar's danger-color threshold
   *  ({@link QR_WARN_SEC}). */
  readonly qrRemainingSec = signal(0);
  readonly qrRemainingText = computed(() => {
    const seconds = Math.max(0, this.qrRemainingSec());
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
  /** Pending scheduled (re)mint — drives both the silent expiry-refresh and the backoff retry on a transient
   *  qrCreate failure. One timer at a time; every code path that mints clears it first. */
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive qrCreate failures since the last success. A normal expiry-refresh does NOT count against
   *  this — only genuine create errors (network drop / non-zero code) do. Once it exceeds the budget below
   *  the page falls through to a recoverable error view instead of looping the backend forever. */
  private consecutiveCreateFailures = 0;
  /** Max qrCreate retries before surfacing the error view, and the per-attempt delays. The expiry-refresh
   *  beat is short (just long enough for the loading spinner to register); the create-retry backoff is
   *  linear so a sustained outage backs off rather than hammering. */
  private static readonly MAX_CREATE_RETRIES = 3;
  private static readonly EXPIRY_REFRESH_DELAY_MS = 700;
  private static readonly CREATE_RETRY_BASE_MS = 1500;
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
    this.stopRefresh();
  }

  private start(): void {
    this.stopCountdown();
    this.stopRefresh();
    this.view.set('loading');
    // client follows the real platform (app/web/desktop) and trust follows the platform's capability —
    // both are constant for this app session, so the QR is minted once at the right level (no toggle).
    this.auth.qrCreate(sessionClient(), this.qrTrusted)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: (res) => {
        if (res.code === 0 && res.data) {
          this.consecutiveCreateFailures = 0;
          this.qrToken.set(res.data.qrToken);
          this.qrDeadline = res.data.expiresAt;
          this.qrTotalMs = Math.max(1, res.data.expiresAt - Date.now());
          this.qrRemainingPct.set(100);
          this.qrRemainingSec.set(Math.ceil(this.qrTotalMs / 1000));
          this.view.set('pending');
          this.beginCountdown();
          this.beginPoll();
        } else {
          this.handleCreateFailure();
        }
      },
      error: () => this.handleCreateFailure(),
    });
  }

  /** A qrCreate failure (network drop or non-zero code). Give it a bounded number of linear-backoff retries
   *  so a transient blip self-heals while the loading spinner keeps the square occupied; once the budget is
   *  gone, surface the recoverable error view instead of looping forever. */
  private handleCreateFailure(): void {
    this.consecutiveCreateFailures += 1;
    if (this.consecutiveCreateFailures > QrLoginPageComponent.MAX_CREATE_RETRIES) {
      this.consecutiveCreateFailures = 0;
      this.view.set('error');
      return;
    }
    this.view.set('loading');
    const delay = QrLoginPageComponent.CREATE_RETRY_BASE_MS * this.consecutiveCreateFailures;
    this.refreshTimer = setTimeout(() => this.start(), delay);
  }

  /** Normal TTL expiry (countdown hit zero, or the poll reported `expired`) — NOT an error. Tear down the
   *  consumed token, flip to loading so the spinner fills the square, and mint a fresh code after a brief
   *  beat: long enough for the spinner to register, short enough that the user isn't left waiting, and never
   *  a tight loop even if the backend hands back a near-zero TTL. */
  private refreshAfterExpiry(): void {
    this.stopPoll();
    this.stopCountdown();
    this.qrToken.set(null);
    this.qrRemainingPct.set(0);
    this.qrRemainingSec.set(0);
    this.view.set('loading');
    this.refreshTimer = setTimeout(() => this.start(), QrLoginPageComponent.EXPIRY_REFRESH_DELAY_MS);
  }

  private stopRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private beginPoll(): void {
    const token = this.qrToken();
    if (!token) return;
    this.stopPoll();
    this.pollTimer = setInterval(() => {
      this.auth.qrPoll(token, undefined, this.qrTrusted)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (res) => {
            if (res.code === 0 && res.data?.session_token) {
              this.stopPoll();
              this.routeService.redirect(
                res.data?.mustChangePassword ? RoutePage.AUTH_SET_PASSWORD : RoutePage.HOME,
              );
            } else if (res.code === 0 && res.data?.status === 'scanned') {
              // Scanned → "confirm on phone". The token is NOT consumed at scan (only at confirm's atomic
              // claim), and the backend keeps the ORIGINAL deadline — so the countdown keeps running: it
              // stays accurate through the confirm window AND drives the refresh if the phone never confirms,
              // mirroring pending without waiting for the poll to report 'expired'.
              this.view.set('scanned');
            } else if (res.code === 0 && res.data?.status === 'expired') {
              this.refreshAfterExpiry();
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
      this.refreshAfterExpiry();
      return;
    }
    this.qrRemainingPct.set(Math.min(100, (remaining / this.qrTotalMs) * 100));
    this.qrRemainingSec.set(Math.ceil(remaining / 1000));
  }

  private stopCountdown(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = undefined;
  }

  /** Manual retry from the error view (genuine create failures exhausted the backoff budget). Clears the
   *  counter so a fresh outage earns its full retry budget again, then mints anew. */
  retry(): void {
    this.consecutiveCreateFailures = 0;
    this.stopPoll();
    this.stopRefresh();
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
