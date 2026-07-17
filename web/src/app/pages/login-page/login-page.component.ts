import { Component, signal, computed, inject } from '@angular/core';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { LoginComponent } from '../../components/login/login.component';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { ConfigService } from '../../services/config.service';
import { AuthService } from '../../services/auth.service';
import { apiOrigin, isTauri, tauriInvoke } from '../../services/runtime';

@Component({
    selector: 'app-login-page',
    imports: [LoginComponent, AuthBrandComponent, AuthToolbarComponent, TranslocoPipe, MatButtonModule, IconComponent],
    templateUrl: './login-page.component.html',
    styleUrl: './login-page.component.scss'
})
export class LoginPageComponent {
  // Exposed for the template so the server banner + "Configure server" entry render only inside the
  // Tauri shell (browser build is same-origin; nothing to report or reconfigure there).
  protected readonly isTauri = isTauri;
  protected readonly AppIcon = AppIconType;
  private readonly config = inject(ConfigService);
  private readonly auth = inject(AuthService);
  private readonly transloco = inject(TranslocoService);

  // --- Origin banner (shows the configured backend prominently on the login page). https = green globe
  //     (cert was validated at init); http/IP = red (insecure — validation skipped, not guaranteed secure). ---
  readonly originHost = computed(() => {
    const o = apiOrigin();
    try {
      return o ? new URL(o).host : '';
    } catch {
      return o;
    }
  });
  readonly originInsecure = computed(() => {
    const o = apiOrigin();
    if (!o) return true;
    try {
      return new URL(o).protocol !== 'https:';
    } catch {
      return true;
    }
  });
  readonly originSchemeLabel = computed(() => (this.originInsecure() ? 'HTTP' : 'HTTPS'));
  readonly originIcon = computed(() => (this.originInsecure() ? AppIconType.REPORT : AppIconType.GLOBE));


  /** One-shot notice shown after a server-initiated kick (e.g. "signed in elsewhere" when a new OTP login
   *  replaced this app session). Set from AuthService.consumeLoginNotice() on construct. */
  readonly notice = signal('');
  /** Render the password form only when password is an enabled method for this platform. Before config
   *  loads (methodsForPlatform() is empty) this is false, so nothing flashes; under APP_OTP_AND_QR mode it
   *  stays false and the constructor redirects to the platform's method. */
  readonly showPassword = computed(() => this.config.methodsForPlatform().includes('password'));
  /** Switcher targets — each shows only when that method is enabled for this platform (so the switcher
   *  appears iff >1 method is available, per the multi-method requirement). */
  readonly canOtp = computed(() => this.config.methodsForPlatform().includes('otp'));
  readonly canQr = computed(() => this.config.methodsForPlatform().includes('qr'));

  constructor(private routeService: RouteService) {
    const noticeKey = this.auth.consumeLoginNotice();
    if (noticeKey) this.notice.set(this.transloco.translate(noticeKey));
    void this.config.ensureLoaded().then(() => this.routeAwayIfPasswordDisabled());
  }

  /** Under APP_OTP_AND_QR mode password is disabled — bounce to the platform's enabled method so the user
   *  never lands on an empty password page. No-op when password is available (the form renders normally). */
  private routeAwayIfPasswordDisabled(): void {
    const methods = this.config.methodsForPlatform();
    if (methods.includes('password')) return;
    if (methods.includes('otp')) this.routeService.redirect(RoutePage.AUTH_OTP);
    else if (methods.includes('qr')) this.routeService.redirect(RoutePage.AUTH_QR);
  }

  /** Login succeeded. The payload is the session's `mustChangePassword` flag — route to the forced
   *  set-password screen (not home) when the session is still on the admin-generated initial password. */
  onSuccess(mustChangePassword: boolean) {
    this.routeService.redirect(mustChangePassword ? RoutePage.AUTH_SET_PASSWORD : RoutePage.HOME)
  }

  jumpToOtp() {
    this.routeService.redirect(RoutePage.AUTH_OTP)
  }

  jumpToQr() {
    this.routeService.redirect(RoutePage.AUTH_QR)
  }

  /** Reopen the bundled bootstrap as the `init` window over this one (reconfigure). Rust creates the
   *  init window (tauri://localhost), the bootstrap runs the same 3 init steps against the new origin,
   *  then hands back to the SPA. Replaces the old in-SPA `/config` page (now removed). */
  reopenServerConfig(): void {
    tauriInvoke('open_init').catch((e) => console.error('open_init failed', e));
  }
}
