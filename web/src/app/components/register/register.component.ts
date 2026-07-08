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
  @Output() onSuccess = new EventEmitter<{ uniqName: string, password: string }>();

  readonly AppIcon = AppIconType;
  private readonly transloco = inject(TranslocoService);

  uniqName = signal('');
  name = signal('');
  password = signal('');
  password2 = signal('');
  uniqNameHint = signal('');
  nameHint = signal('');
  passwordHint = signal('');
  isUniqNameVld = signal(false);
  isNameVld = signal(false);
  isPwdVld = signal(false);
  resp = signal('');
  showPassword = signal(false)
  isReging = signal(false)
  isRegBtnDisabled = computed(() => {
    return this.isSuccess() || this.isReging() || this.isUniqNameVld() === false || this.isNameVld() === false || this.isPwdVld() === false
  })
  isSuccess = signal(false)
  // Telegram-style handle: starts with a letter, then 2-30 more of [a-zA-Z0-9_] (3-31 total). Matches
  // the backend RegisterDto rule; alnum + underscore keeps the handle URL/address-safe for username@domain.
  private _uniqNameRegex = /^[a-zA-Z][a-zA-Z0-9_]{2,30}$/
  private _passwordRegx: RegExp = /^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/;
  constructor(private userService: UserService, private routeService: RouteService) {
    effect(() => {
      const uniqname = this.uniqName()
      if (!this._uniqNameRegex.test(uniqname)) {
        this.isUniqNameVld.set(false)
        this.uniqNameHint.set(this.transloco.translate('auth.uniqNameHint'))
      } else {
        this.isUniqNameVld.set(true)
        this.uniqNameHint.set('')
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

  onUniqNameInput(v: string) {
    this.uniqName.set(v)
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
    const uniqName = this.uniqName(), password = this.password()
    if (this.password2() !== password) {
      this.resp.set(this.transloco.translate('auth.passwordMismatch'))
      return
    }
    this.isReging.set(true)
    this.userService.register({ uniqName, name: this.name().trim(), password })
      .subscribe({
        next: (res) => {
          if (res.code === 0) {
            this.onSuccess.emit({ uniqName, password })
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
