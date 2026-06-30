import { Component, signal, computed, Output, EventEmitter, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UserService } from '../../services/user.service';
import { IconComponent, AppIconType } from '../../components/icon/icon.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';

@Component({
    selector: 'app-register',
    imports: [IconComponent, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatProgressBarModule],
    templateUrl: './register.component.html',
    styleUrl: './register.component.scss'
})
export class RegisterComponent {
  @Output() onSuccess = new EventEmitter<{ uniqName: string, password: string }>();

  readonly AppIcon = AppIconType;

  uniqName = signal('');
  password = signal('');
  password2 = signal('');
  uniqNameHint = signal('');
  passwordHint = signal('');
  isUniqNameVld = signal(false);
  isPwdVld = signal(false);
  resp = signal('');
  showPassword = signal(false)
  isReging = signal(false)
  isRegBtnDisabled = computed(() => {
    return this.isSuccess() || this.isReging() || this.isUniqNameVld() === false || this.isPwdVld() === false
  })
  isSuccess = signal(false)
  /*^ Start of string
    (?=[\w.-]{5,20}$) Assert 5-20 of the allowed characters
    (?:[\d_.-]*[a-zA-Z]){3} Match 3 times a-zA-Z followed by optional digits _ . -
    [\w.-]* Match optional word chars or . or -
    $ End of string
  */
  private _uniqNameRegex = /^(?=[\w.-]{1,20}$)(?:[\d_.-]*[a-zA-Z]){3}[\w.-]*$/
  private _passwordRegx: RegExp = /^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/;
  constructor(private userService: UserService, private routeService: RouteService) {
    effect(() => {
      const uniqname = this.uniqName()
      if (!this._uniqNameRegex.test(uniqname)) {
        this.isUniqNameVld.set(false)
        this.uniqNameHint.set('1 to 20 letters/numbers')
      } else {
        this.isUniqNameVld.set(true)
        this.uniqNameHint.set('')
      }
    })
    effect(() => {
      const password = this.password()
      if (!this._passwordRegx.test(password)) {
        this.isPwdVld.set(false)
        this.passwordHint.set('6 to 20 letters/numbers/symbols')
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
      this.resp.set("Two entered passwords do not match, make sure to re-enter")
      return
    }
    this.isReging.set(true)
    this.userService.register({ uniqName, password })
      .subscribe({
        next: ({ code, message }) => {
          if (code === 0) {
            this.onSuccess.emit({ uniqName, password })
            this.isReging.set(false)
            this.isSuccess.set(true)
          } else {
            this.resp.set(message)
          }
          this.isReging.set(false)
        },
        error: (err) => {
          console.error(err)
          this.resp.set('unknown error occurred')
          this.isReging.set(false)
        }
      })
  }

  jumpToLogin() {
    this.routeService.navigate(RoutePage.AUTH_LOGIN)
  }
}
