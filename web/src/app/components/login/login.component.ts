import {
  Component,
  signal,
  computed,
  Output,
  EventEmitter,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { finalize } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { AuthService } from '../../services/auth.service';
import { ConfigService, LoginMethod } from '../../services/config.service';
import { ToastService } from '../../services/toast.service';
import { translateBizResult } from '../../services/biz-code';
import {
  IconComponent,
  AppIconType,
} from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { QrStageComponent } from '../qr-stage/qr-stage.component';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [
    IconComponent,
    FormsModule,
    TranslocoPipe,
    MatButtonModule,
    MatTabsModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    QrStageComponent,
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
  private readonly toast = inject(ToastService);
  private readonly activatedRoute = inject(ActivatedRoute, { optional: true });
  /** Public site config — hides the register link when registration is closed. Pre-fetched on construct so
   *  the link's visibility settles as soon as /config resolves (idempotent across all login components). */
  readonly config = inject(ConfigService);

  readonly activeMethod = signal<LoginMethod>('password');

  readonly canPassword = computed(() =>
    this.config.methodsForPlatform().includes('password'),
  );
  readonly canOtp = computed(() =>
    this.config.methodsForPlatform().includes('otp'),
  );
  readonly canQr = computed(() =>
    this.config.methodsForPlatform().includes('qr'),
  );

  readonly selectedTabIndex = computed(() => {
    switch (this.activeMethod()) {
      case 'password':
        return 0;
      case 'otp':
        return 1;
      case 'qr':
        return 2;
      default:
        return 0;
    }
  });

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
    if (routeMode === 'otp' || routeMode === 'qr' || routeMode === 'password') {
      this.activeMethod.set(routeMode);
    }

    void this.config.ensureLoaded().then(() => {
      if (!this.isMethodEnabled(this.activeMethod())) {
        if (this.canPassword()) this.activeMethod.set('password');
        else if (this.canOtp()) this.activeMethod.set('otp');
        else if (this.canQr()) this.activeMethod.set('qr');
      }
    });
  }

  isMethodEnabled(method: LoginMethod): boolean {
    switch (method) {
      case 'password':
        return this.canPassword();
      case 'otp':
        return this.canOtp();
      case 'qr':
        return this.canQr();
      default:
        return false;
    }
  }

  onTabChange(index: number) {
    const methods: LoginMethod[] = ['password', 'otp', 'qr'];
    const target = methods[index];
    if (target && this.isMethodEnabled(target)) {
      this.setMethod(target);
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
