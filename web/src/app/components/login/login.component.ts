import { Component, signal, computed, Output, EventEmitter, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { AuthService } from '../../services/auth.service'
import { ConfigService } from '../../services/config.service'
import { translateBizResult } from '../../services/biz-code'
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { isTauri, isAndroidNative } from '../../services/runtime';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';

@Component({
    selector: 'app-login',
    imports: [IconComponent, FormsModule, TranslocoPipe, MatButtonModule, MatCheckboxModule,
        MatFormFieldModule, MatInputModule, MatProgressBarModule],
    templateUrl: './login.component.html',
    styleUrl: './login.component.scss'
})
export class LoginComponent {
  /** Fires on a successful login. The boolean payload is the resulting session's `mustChangePassword`
   *  flag — the page routes to the forced set-password screen (not home) when the session is still on the
   *  admin-generated initial password. */
  @Output() onSuccess = new EventEmitter<boolean>();

  readonly AppIcon = AppIconType;
  private readonly transloco = inject(TranslocoService);
  /** Public site config — hides the register link when registration is closed. Pre-fetched on construct so
   *  the link's visibility settles as soon as /config resolves (idempotent across all login components). */
  readonly config = inject(ConfigService);

  account = signal('');
  password = signal('');
  resp = signal('');
  showPassword = signal(false)
  isKeepLogin = signal(true)
  /** Desktop (Tauri, non-Android, with a working OS keyring) shows a "Trust this device" toggle instead of
   *  "Keep me logged in": trusted → token in the OS keyring + a permanent session. Hidden when the boot
   *  keyring probe failed (can't persist → would orphan a permanent session), and on web/Android. */
  get showTrust(): boolean { return isTauri() && !isAndroidNative() && this.authService.canTrust }
  trustDevice = signal(false)
  isLoging = signal(false)
  isSuccess = signal(false)
  isLoginBtnDisabled = computed(() => {
    return this.isSuccess() || this.isLoging() || this.account() === '' || this.password() === ''
  })

  constructor(private authService: AuthService, private routeService: RouteService) {
    void this.config.ensureLoaded();
  }

  togglePassword() {
    this.showPassword.update(v => !v)
  }

  onAccountInput(v: string) {
    this.account.set(v)
    this.clearError()
  }

  onPasswordInput(v: string) {
    this.password.set(v)
    this.clearError()
  }

  private clearError() {
    if (this.resp()) {
      this.resp.set('')
    }
  }

  login() {
    if (this.isLoging()) {
      return
    }
    this.isLoging.set(true)
    this.authService.login({
      account: this.account(),
      password: this.password(),
      // Desktop: the trust toggle drives BOTH keep (OS keyring persistence) and trusted (permanent token).
      // Web/Android: the cookie-persistence checkbox; trusted is web-disabled (the app client is auto-trusted).
      isKeep: this.showTrust ? this.trustDevice() : this.isKeepLogin(),
      trustDevice: this.showTrust && this.trustDevice(),
    })
      .subscribe({
        next: (res) => {
          if (res.code === 0) {
            this.onSuccess.emit(!!res.data?.mustChangePassword)
            this.isSuccess.set(true)
            this.isLoging.set(false)
          } else {
            this.resp.set(translateBizResult(res, this.transloco))
            this.isLoging.set(false)
          }
        },
        error: (err) => {
          console.error(err)
          this.resp.set(this.transloco.translate('auth.unknownError'))
          this.isLoging.set(false)
        }
      })
  }

  jumpToRegister() {
    // replaceUrl: switching login↔register must not stack an auth entry beneath the next one — otherwise
    // back from home after a successful login could reach the login page (the clean-history contract in
    // auth.guard.ts: every navigation INTO an auth page replaces).
    this.routeService.redirect(RoutePage.AUTH_REGISTER)
  }
}
