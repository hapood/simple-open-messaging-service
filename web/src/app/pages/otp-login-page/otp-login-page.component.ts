import {
  Component,
  signal,
  computed,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { AuthBrandComponent } from '../../components/auth-brand/auth-brand.component';
import { AuthToolbarComponent } from '../../components/auth-toolbar/auth-toolbar.component';
import {
  IconComponent,
  AppIconType,
} from '../../components/icon/icon.component';
import { AuthService } from '../../services/auth.service';
import { ConfigService } from '../../services/config.service';
import { RouteService, RoutePage } from '../../services/route.service';
import { translateBizResult } from '../../services/biz-code';
import { isTauri } from '../../services/runtime';
import { AuthViewportDirective } from '../../directives/auth-viewport.directive';
import { AuthMethodMenuComponent } from '../../components/auth-method-menu/auth-method-menu.component';
import { BrandLogoComponent } from '../../components/brand-logo/brand-logo.component';
import { ServerConfigDialogService } from '../../services/server-config-dialog.service';

/**
 * One-time-code login page (every platform). The user enters the account the admin issued the code for + the
 * 6-digit code → a session whose lifetime follows the platform's trust (native permanent, browser 14-day).
 * Reached automatically from `/auth/login` under APP_OTP_AND_QR mode (password disabled). Shows switchers to
 * the other enabled methods (password under mode ALL, QR always under the alt modes), a web-session notice
 * on the browser, and a one-shot notice when the prior app session was replaced ("signed in elsewhere").
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
    AuthViewportDirective,
    AuthMethodMenuComponent,
    BrandLogoComponent,
  ],
  templateUrl: './otp-login-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './otp-login-page.component.scss',
})
export class OtpLoginPageComponent {
  protected readonly isTauri = isTauri;
  protected readonly AppIcon = AppIconType;
  private readonly transloco = inject(TranslocoService);
  private readonly auth = inject(AuthService);
  private readonly routeService = inject(RouteService);
  private readonly serverConfigDialog = inject(ServerConfigDialogService);
  readonly config = inject(ConfigService);

  account = signal('');
  code = signal('');
  resp = signal('');
  isSubmitting = signal(false);
  isDisabled = computed(
    () => this.isSubmitting() || this.account() === '' || this.code() === '',
  );
  /** Password login is offered as a switcher option when enabled for this platform (mode ALL). */
  readonly canPassword = computed(() =>
    this.config.methodsForPlatform().includes('password'),
  );
  /** QR login is offered as a switcher when enabled — always so under APP_OTP_AND_QR/ALL. Android is the one
   *  platform where OTP and QR coexist, so the OTP page links across to QR there. */
  readonly canQr = computed(() =>
    this.config.methodsForPlatform().includes('qr'),
  );

  constructor() {
    void this.config.ensureLoaded();
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
    this.auth
      .otpLogin({ account: this.account(), code: this.code() })
      .subscribe({
        next: (res) => {
          if (res.code === 0) {
            this.routeService.redirect(
              res.data?.mustChangePassword
                ? RoutePage.AUTH_SET_PASSWORD
                : RoutePage.HOME,
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

  jumpToQr() {
    // replaceUrl: switching login methods must not stack entries (the clean-history contract).
    this.routeService.redirect(RoutePage.AUTH_QR);
  }

  openServerConfig(): void {
    this.serverConfigDialog.open();
  }
}
