import {
  Component,
  signal,
  computed,
  Output,
  EventEmitter,
  inject,
  ChangeDetectionStrategy,
  WritableSignal,
} from '@angular/core';
import { finalize } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { AuthService } from '../../services/auth.service';
import {
  ConfigService,
  LoginMethod,
  LoginMethodOption,
} from '../../services/config.service';
import { ToastService } from '../../services/toast.service';
import { translateBizResult } from '../../services/biz-code';
import {
  IconComponent,
  AppIconType,
} from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { LanguageService } from '../../services/language.service';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { QrStageComponent } from '../qr-stage/qr-stage.component';
import { BrandLogoComponent } from '../brand-logo/brand-logo.component';
import {
  SegmentedButtonComponent,
  SegmentedButtonOption,
} from '../segmented-button/segmented-button.component';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [
    IconComponent,
    FormsModule,
    TranslocoPipe,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    QrStageComponent,
    BrandLogoComponent,
    SegmentedButtonComponent,
  ],
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  /** Fires on a successful login. The boolean payload is the resulting session's `mustChangePassword`
   *  flag — the page routes to the forced set-password screen (not home) when the session is still on the
   *  admin-generated initial password. */
  @Output() onSuccess = new EventEmitter<boolean>();

  readonly AppIcon = AppIconType;
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  private readonly toast = inject(ToastService);
  private readonly activatedRoute = inject(ActivatedRoute, { optional: true });
  /** Public site config — tab order, disabled state, default method and the register-link visibility all
   *  come from it (pre-fetched on construct; idempotent across all login components). */
  readonly config = inject(ConfigService);

  /** Ordered options straight from the public config — drives tab order and each tab's disabled state. */
  readonly methodOptions = computed<LoginMethodOption[]>(
    () => this.config.loginMethods() ?? [],
  );

  /** Labels are translated eagerly; reading the language signal keeps them reactive to
   *  runtime language switches (transloco.translate alone would return a stale snapshot). */
  readonly segmentedOptions = computed<SegmentedButtonOption<LoginMethod>[]>(
    () => {
      this.language.lang();
      return this.methodOptions().map((item) => ({
        key: item.key,
        label: this.transloco.translate(this.tabLabelKey(item.key)),
        icon: item.key,
        disabled: item.disabled,
      }));
    },
  );

  /** The active login method. Initialized from the `?mode=` query param (when that method is usable) or
   *  the server-advertised default; re-picked if a config reload changes the policy under our feet. */
  readonly activeMethod: WritableSignal<LoginMethod>;

  account = signal('');
  password = signal('');
  code = signal('');
  resp = signal('');
  showPassword = signal(false);
  isLoging = signal(false);
  isSuccess = signal(false);

  isLoginBtnDisabled = computed(() => {
    if (this.isSuccess() || this.isLoging() || this.account() === '') {
      return true;
    }
    if (this.activeMethod() === 'otp') {
      return this.code() === '';
    }
    return this.password() === '';
  });

  constructor(
    private authService: AuthService,
    private routeService: RouteService,
  ) {
    const routeMode = this.activatedRoute?.snapshot?.queryParamMap?.get(
      'mode',
    ) as LoginMethod | null;
    this.activeMethod = signal<LoginMethod>(this.pickInitialMethod(routeMode));

    void this.config.ensureLoaded().then(() => {
      if (!this.isMethodEnabled(this.activeMethod())) {
        this.activeMethod.set(this.pickInitialMethod(null));
      }
    });
  }

  /** Query param wins when its method is enabled; otherwise the advertised default; otherwise the first
   *  enabled entry. Only reachable with an empty policy before the first load settles (the login page
   *  gates rendering on the config being ready), in which case any placeholder is fine — the
   *  ensureLoaded continuation above re-picks once the real policy arrives. */
  private pickInitialMethod(routeMode: LoginMethod | null): LoginMethod {
    if (routeMode && this.isMethodEnabled(routeMode)) {
      return routeMode;
    }
    const def = this.config.defaultLoginMethod();
    if (def && this.isMethodEnabled(def)) {
      return def;
    }
    const firstEnabled = this.methodOptions().find((m) => !m.disabled);
    if (firstEnabled) {
      return firstEnabled.key;
    }
    return routeMode ?? 'password';
  }

  isMethodEnabled(method: LoginMethod): boolean {
    const item = this.methodOptions().find((m) => m.key === method);
    return item !== undefined && !item.disabled;
  }

  /** Transloco key for a tab label — the template loops over the data-driven option list. */
  tabLabelKey(key: LoginMethod): string {
    switch (key) {
      case 'qr':
        return 'auth.tabQr';
      case 'otp':
        return 'auth.tabOtp';
      default:
        return 'auth.tabPassword';
    }
  }

  onSegmentChange(method?: LoginMethod) {
    if (method) {
      this.setMethod(method);
    }
  }

  setMethod(method: LoginMethod) {
    this.activeMethod.set(method);
    this.clearError();
  }

  togglePassword() {
    this.showPassword.update((v) => !v);
  }

  onAccountInput(v: string) {
    this.account.set(v);
    this.clearError();
  }

  onPasswordInput(v: string) {
    this.password.set(v);
    this.clearError();
  }

  onCodeInput(v: string) {
    this.code.set(v);
    this.clearError();
  }

  private clearError() {
    if (this.resp()) {
      this.resp.set('');
    }
  }

  login() {
    if (this.isLoging()) {
      return;
    }
    this.isLoging.set(true);

    if (this.activeMethod() === 'otp') {
      this.authService
        .otpLogin({
          account: this.account(),
          code: this.code(),
        })
        .pipe(finalize(() => this.isLoging.set(false)))
        .subscribe({
          next: (res) => {
            if (res.code === 0) {
              this.onSuccess.emit(!!res.data?.mustChangePassword);
              this.isSuccess.set(true);
            } else {
              const msg = translateBizResult(res, this.transloco);
              this.resp.set(msg);
              this.toast.warn(msg);
            }
          },
          error: (err) => {
            console.error(err);
            const msg = this.transloco.translate('auth.unknownError');
            this.resp.set(msg);
            this.toast.warn(msg);
          },
        });
      return;
    }

    this.authService
      .login({
        account: this.account(),
        password: this.password(),
      })
      .pipe(finalize(() => this.isLoging.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code === 0) {
            this.onSuccess.emit(!!res.data?.mustChangePassword);
            this.isSuccess.set(true);
          } else {
            const msg = translateBizResult(res, this.transloco);
            this.resp.set(msg);
            this.toast.warn(msg);
          }
        },
        error: (err) => {
          console.error(err);
          const msg = this.transloco.translate('auth.unknownError');
          this.resp.set(msg);
          this.toast.warn(msg);
        },
      });
  }

  onQrSuccess(mustChangePassword: boolean) {
    this.onSuccess.emit(mustChangePassword);
    this.isSuccess.set(true);
  }

  jumpToRegister() {
    this.routeService.redirect(RoutePage.AUTH_REGISTER);
  }
}
