import { Component, signal, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { AuthService } from '../../services/auth.service';
import { ConfigService } from '../../services/config.service';
import { RouteService, RoutePage } from '../../services/route.service';
import { translateBizResult } from '../../services/biz-code';
import { isTauri } from '../../services/runtime';

/**
 * One-time-code login page (Android only — the `auth/otp` route is canMatch-gated to `isAndroidNative`).
 * The user enters the account the admin issued the code for + the 6-digit code → a long-term `app` session.
 * Reached automatically from `/auth/login` under APP_OTP_AND_QR mode (password disabled). Shows a switcher
 * back to password login when both are enabled (mode ALL), and a one-shot notice when the prior app session
 * was replaced ("signed in elsewhere").
 */
@Component({
  selector: 'app-otp-login-page',
  imports: [
    AuthBrandComponent,
    AuthToolbarComponent,
    IconComponent,
    FormsModule,
    TranslocoPipe,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    RouterLink,
  ],
  templateUrl: './otp-login-page.component.html',
  styleUrl: './otp-login-page.component.scss',
})
export class OtpLoginPageComponent {
  protected readonly isTauri = isTauri;
  protected readonly AppIcon = AppIconType;
  private readonly transloco = inject(TranslocoService);
  private readonly auth = inject(AuthService);
  private readonly routeService = inject(RouteService);
  readonly config = inject(ConfigService);

  account = signal('');
  code = signal('');
  resp = signal('');
  notice = signal('');
  isSubmitting = signal(false);
  isDisabled = computed(() => this.isSubmitting() || this.account() === '' || this.code() === '');
  /** Password login is offered as a switcher option when enabled for this platform (mode ALL). */
  readonly canPassword = computed(() => this.config.methodsForPlatform().includes('password'));

  constructor() {
    void this.config.ensureLoaded();
    const noticeKey = this.auth.consumeLoginNotice();
    if (noticeKey) this.notice.set(this.transloco.translate(noticeKey));
  }

  onAccountInput(v: string) {
    this.account.set(v);
    this.clearError();
  }
  onCodeInput(v: string) {
    this.code.set(v);
    this.clearError();
  }
  private clearError() {
    if (this.resp()) this.resp.set('');
  }

  submit() {
    if (this.isSubmitting()) return;
    this.isSubmitting.set(true);
    this.auth.otpLogin({ account: this.account(), code: this.code() }).subscribe({
      next: (res) => {
        if (res.code === 0) {
          this.routeService.redirect(
            res.data?.mustChangePassword ? RoutePage.AUTH_SET_PASSWORD : RoutePage.HOME,
          );
        } else {
          this.resp.set(translateBizResult(res, this.transloco));
          this.isSubmitting.set(false);
        }
      },
      error: () => {
        this.resp.set(this.transloco.translate('auth.unknownError'));
        this.isSubmitting.set(false);
      },
    });
  }

  jumpToPassword() {
    // replaceUrl: switching login methods must not stack entries (the clean-history contract).
    this.routeService.redirect(RoutePage.AUTH_LOGIN);
  }
}
