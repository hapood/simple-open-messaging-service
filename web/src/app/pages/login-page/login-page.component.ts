import { Component, signal, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { LoginComponent } from '../../components/login/login.component';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { ConfigService } from '../../services/config.service';
import { AuthService } from '../../services/auth.service';
import { isTauri } from '../../services/runtime';

@Component({
    selector: 'app-login-page',
    imports: [LoginComponent, AuthBrandComponent, AuthToolbarComponent, RouterLink, TranslocoPipe, MatButtonModule, IconComponent],
    templateUrl: './login-page.component.html',
    styleUrl: './login-page.component.scss'
})
export class LoginPageComponent {
  // Exposed for the template so the "Server settings" entry renders only inside the Tauri shell
  // (browser build is same-origin; the config page is canMatch-gated to isTauri anyway).
  protected readonly isTauri = isTauri;
  protected readonly AppIcon = AppIconType;
  private readonly config = inject(ConfigService);
  private readonly auth = inject(AuthService);
  private readonly transloco = inject(TranslocoService);

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

  onSuccess() {
    this.routeService.redirect(RoutePage.HOME)
  }

  jumpToOtp() {
    this.routeService.redirect(RoutePage.AUTH_OTP)
  }

  jumpToQr() {
    this.routeService.redirect(RoutePage.AUTH_QR)
  }
}
