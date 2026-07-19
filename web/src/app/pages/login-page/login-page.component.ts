import { Component, computed, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { LoginComponent } from '../../components/login/login.component';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { BrandLogoComponent } from '../../components/brand-logo/brand-logo.component';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { ConfigService } from '../../services/config.service';
import { apiOrigin, isTauri } from '../../services/runtime';

@Component({
    selector: 'app-login-page',
    imports: [LoginComponent, AuthBrandComponent, AuthToolbarComponent, BrandLogoComponent, TranslocoPipe, MatButtonModule, MatProgressSpinnerModule, IconComponent],
    templateUrl: './login-page.component.html',
    styleUrl: './login-page.component.scss'
})
export class LoginPageComponent {
  // Exposed for the template so the server banner + "Configure server" entry render only inside the
  // Tauri shell (browser build is same-origin; nothing to report or reconfigure there).
  protected readonly isTauri = isTauri;
  protected readonly AppIcon = AppIconType;
  private readonly config = inject(ConfigService);

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


  /** Render the password form only when password is an enabled method for this platform. Before config
   *  loads (methodsForPlatform() is empty) this is false, so nothing flashes; under APP_OTP_AND_QR mode it
   *  stays false and the constructor redirects to the platform's method. */
  readonly showPassword = computed(() => this.config.methodsForPlatform().includes('password'));
  /** Switcher targets — each shows only when that method is enabled for this platform (so the switcher
   *  appears iff >1 method is available, per the multi-method requirement). */
  readonly canOtp = computed(() => this.config.methodsForPlatform().includes('otp'));
  readonly canQr = computed(() => this.config.methodsForPlatform().includes('qr'));
  /** True once `/config` has settled (loaded) WITHOUT a `loginMode` — the backend is unreachable or
   *  returned no config. `ensureLoaded` catches the fetch failure silently (so route guards can await it),
   *  so without this the user sees an empty page with no clue why; this surfaces a visible error + a
   *  reconfigure action. */
  readonly configFailed = computed(() => this.config.loaded() && this.config.loginMode() === null);
  /** True when the login page is a legitimate destination and should paint its CONTENT: the first `/config`
   *  fetch has settled AND (password is an enabled method, OR the backend is unreachable so the error card
   *  must show). Until then the splash-continuous loading view is shown — and that splash window covers TWO
   *  gaps, not one:
   *    1. the `/config` fetch (bridges the index.html app-splash so the window never paints blank), and
   *    2. the redirect window: when password is disabled and the backend is fine the page is the WRONG
   *       destination — the constructor bounces to the platform's enabled method (otp/qr) — and holding the
   *       splash until that navigation lands means the form / origin-banner / method-switcher never flash
   *       for a frame on the way out (the `APP_OTP_AND_QR` flash). The splash is the negation of this. */
  readonly ready = computed(() => this.config.loaded() && (this.showPassword() || this.configFailed()));

  constructor(private routeService: RouteService) {
    void this.config.ensureLoaded().then(() => this.routeAwayIfPasswordDisabled());
  }

  /** Under APP_OTP_AND_QR mode password is disabled — bounce to an enabled method so the user never lands on
   *  an empty password page. QR is the preferred landing (self-service scan); OTP is the fallback. No-op when
   *  password is available (the form renders normally). */
  private routeAwayIfPasswordDisabled(): void {
    const methods = this.config.methodsForPlatform();
    if (methods.includes('password')) return;
    if (methods.includes('qr')) this.routeService.redirect(RoutePage.AUTH_QR);
    else if (methods.includes('otp')) this.routeService.redirect(RoutePage.AUTH_OTP);
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

  /** Open the in-SPA server-config page (reconfigure). Under the merged single-frontend shell this is a
   *  plain router navigation — no Rust window swap (the former `open_init`/bootstrap are gone). */
  reopenServerConfig(): void {
    this.routeService.redirect(RoutePage.CONFIG);
  }

  /** Re-fetch `/config` (the cached load settled as a failure, or the origin was just reconfigured).
   *  `reload()` clears the cached promise + resets the signals, so `ready()` flips false and the error
   *  card is replaced by the spinner until the new request settles — the user gets immediate feedback that
   *  the retry is in flight. */
  retry(): void {
    void this.config.reload();
  }
}
