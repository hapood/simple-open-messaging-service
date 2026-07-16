import { Component, signal, computed, inject, OnDestroy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
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
 * NOTE: the QR *image* rendering (encoding `qrToken` into a scannable matrix) and the Android-side *camera
 * scanner* (the phone that scans + confirms) are the two remaining QR-UX pieces — they need a QR-rendering
 * dependency and the Tauri barcode-scanner plugin respectively. The backend round-trip (create → poll →
 * scan → confirm) is fully wired here and on the server (Stage 3); until the image + scanner land, the
 * token is shown as text for integration testing.
 */
@Component({
  selector: 'app-qr-login-page',
  imports: [
    AuthBrandComponent,
    AuthToolbarComponent,
    IconComponent,
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
  private readonly transloco = inject(TranslocoService);

  qrToken = signal<string | null>(null);
  view = signal<QrView>('loading');
  notice = signal('');
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
    this.auth.qrCreate(client).subscribe({
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
      this.auth.qrPoll(token).subscribe({
        next: (res) => {
          if (res.code === 0 && res.data?.session_token) {
            this.stopPoll();
            this.routeService.redirect(RoutePage.HOME);
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

  jumpToPassword(): void {
    this.routeService.redirect(RoutePage.AUTH_LOGIN);
  }
}
