import { Component, signal, computed, inject, OnDestroy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { QrCodeComponent } from '../../components/qr-code/qr-code.component';
import { AuthService } from '../../services/auth.service';
import { ConfigService } from '../../services/config.service';
import { RouteService, RoutePage } from '../../services/route.service';
import { isTauri } from '../../services/runtime';

type QrView = 'loading' | 'pending' | 'scanned' | 'expired';

/**
 * QR-scan login page (desktop/web). Mints a sign-in token (rendered as a QR for an already-logged-in phone
 * to scan), polls its status, and — once the phone confirms — activates a 2-week sliding session. Reached
 * automatically from `/auth/login` under APP_OTP_AND_QR mode on desktop/web.
 *
 * The QR image is rendered by {@link QrCodeComponent} (uqr matrix → SVG); the phone-side scan + confirm is
 * the two-step "Link a device" flow under Settings → Devices (the Tauri barcode-scanner plugin, Android
 * only). The backend round-trip (create → poll → scan → confirm) is fully wired here and on the server.
 * The sole outstanding item is an on-device APK smoke of the scanner; this desktop render + poll path is
 * complete.
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
    MatCheckboxModule,
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
  private readonly transloco = inject(TranslocoService);

  qrToken = signal<string | null>(null);
  view = signal<QrView>('loading');
  notice = signal('');
  /** Desktop opt-in: a trusted device keeps its token in the OS keyring and receives a permanent session.
   *  Web can't be trusted (no OS secure storage for a bearer token) → this stays false there. */
  trustDevice = signal(false);
  /** The desktop can opt into trust only when its OS keyring is available (probed at boot by
   *  AuthService.restoreSession). Web never can. */
  protected get canTrust(): boolean { return this.auth.canTrust }
  readonly canPassword = computed(() => this.config.methodsForPlatform().includes('password'));

  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    void this.config.ensureLoaded();
    const noticeKey = this.auth.consumeLoginNotice();
    if (noticeKey) this.notice.set(this.transloco.translate(noticeKey));
    this.start();
  }

  ngOnDestroy(): void {
    this.stopPoll();
  }

  private start(): void {
    this.view.set('loading');
    const client: 'web' | 'desktop' = isTauri() ? 'desktop' : 'web';
    this.auth.qrCreate(client, this.trustDevice()).subscribe({
      next: (res) => {
        if (res.code === 0 && res.data) {
          this.qrToken.set(res.data.qrToken);
          this.view.set('pending');
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
      this.auth.qrPoll(token, undefined, this.trustDevice()).subscribe({
        next: (res) => {
          if (res.code === 0 && res.data?.session_token) {
            this.stopPoll();
            this.routeService.redirect(
              res.data?.mustChangePassword ? RoutePage.AUTH_SET_PASSWORD : RoutePage.HOME,
            );
          } else if (res.code === 0 && res.data?.status === 'scanned') {
            this.view.set('scanned');
          } else if (res.code === 0 && res.data?.status === 'expired') {
            this.stopPoll();
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

  /** Refresh: mint a fresh sign-in token after an expiry. */
  retry(): void {
    this.stopPoll();
    this.qrToken.set(null);
    this.start();
  }

  /** Toggle "trust this device" (desktop only): the trust flag is baked into the create request, so flip
   *  the signal and re-mint the QR with the new level. */
  onTrustChange(checked: boolean): void {
    this.trustDevice.set(checked);
    this.retry();
  }

  jumpToPassword(): void {
    this.routeService.redirect(RoutePage.AUTH_LOGIN);
  }
}
