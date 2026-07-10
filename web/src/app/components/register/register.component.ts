import { Component, signal, computed, Output, EventEmitter, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { translateBizResult } from '../../services/biz-code'
import { UserService } from '../../services/user.service';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';

@Component({
    selector: 'app-register',
    imports: [IconComponent, FormsModule, TranslocoPipe, MatButtonModule, MatFormFieldModule, MatInputModule, MatProgressBarModule],
    templateUrl: './register.component.html',
    styleUrl: './register.component.scss'
})
export class RegisterComponent {
  @Output() onSuccess = new EventEmitter<{ account: string, password: string }>();

  readonly AppIcon = AppIconType;
  private readonly transloco = inject(TranslocoService);

  account = signal('');
  name = signal('');
  password = signal('');
  password2 = signal('');
  accountHint = signal('');
  nameHint = signal('');
  passwordHint = signal('');
  isAccountVld = signal(false);
  isNameVld = signal(false);
  isPwdVld = signal(false);
  resp = signal('');
  showPassword = signal(false)
  isReging = signal(false)
  isRegBtnDisabled = computed(() => {
    return this.isSuccess() || this.isReging() || this.isAccountVld() === false || this.isNameVld() === false || this.isPwdVld() === false
  })
  isSuccess = signal(false)
  // Starts with a letter, then letters/digits with single-dot separators (3-31 total). Mirrors the
  // backend USER_ACCOUNT_RE exactly (docs/account-naming.md §3.1) — one grammar, validated client-side
  // for early UX feedback and again server-side. Dots allowed; underscore is NOT (the backend rejects it).
  private _accountRegex = /^(?=.{3,31}$)[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$/
  private _passwordRegx: RegExp = /^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/;
  constructor(private userService: UserService, private routeService: RouteService) {
    effect(() => {
      const account = this.account()
      if (!this._accountRegex.test(account)) {
        this.isAccountVld.set(false)
        this.accountHint.set(this.transloco.translate('auth.accountHint'))
      } else {
        this.isAccountVld.set(true)
        this.accountHint.set('')
      }
    })
    effect(() => {
      // Display name: lenient charset (unicode/emoji ok), only a length bound client-side. The backend
      // (@IsDisplayName) additionally strips control chars + trims, so this is UX pre-feedback only.
      const name = this.name().trim()
      if (name.length < 1 || name.length > 30) {
        this.isNameVld.set(false)
        this.nameHint.set(this.transloco.translate('auth.displayNameHint'))
      } else {
        this.isNameVld.set(true)
        this.nameHint.set('')
      }
    })
    effect(() => {
      const password = this.password()
      if (!this._passwordRegx.test(password)) {
        this.isPwdVld.set(false)
        this.passwordHint.set(this.transloco.translate('auth.passwordHint'))
      } else {
        this.isPwdVld.set(true)
        this.passwordHint.set('')
      }
    })
  }

  togglePassword() {
    this.showPassword.update(v => !v)
  }

  onAccountInput(v: string) {
    this.account.set(v)
    this.clearError()
  }

  onNameInput(v: string) {
    this.name.set(v)
    this.clearError()
  }

  onPasswordInput(v: string) {
    this.password.set(v)
    this.clearError()
  }

  onPassword2Input(v: string) {
    this.password2.set(v)
    this.clearError()
  }

  private clearError() {
    if (this.resp()) {
      this.resp.set('')
    }
  }

  register() {
    if (this.isReging()) {
      return
    }
    const account = this.account(), password = this.password()
    if (this.password2() !== password) {
      this.resp.set(this.transloco.translate('auth.passwordMismatch'))
      return
    }
    this.isReging.set(true)
    this.userService.register({ account, name: this.name().trim(), password })
      .subscribe({
        next: (res) => {
          if (res.code === 0) {
            this.onSuccess.emit({ account, password })
            this.isReging.set(false)
            this.isSuccess.set(true)
          } else {
            this.resp.set(translateBizResult(res, this.transloco))
          }
          this.isReging.set(false)
        },
        error: (err) => {
          console.error(err)
          this.resp.set(this.transloco.translate('auth.unknownError'))
          this.isReging.set(false)
        }
      })
  }

  jumpToLogin() {
    // replaceUrl: see jumpToRegister — login↔register must replace, not stack.
    this.routeService.redirect(RoutePage.AUTH_LOGIN)
  }
}
