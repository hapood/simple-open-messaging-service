import { Component, signal, computed, Output, EventEmitter, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MaterialInputComponent } from '../material-input/material-input.component';
import { MaterialButtonComponent, MaterialButtonType } from "../material-button/material-button.component";
import { MaterialProgressLinearComponent } from '../material-progress-linear/material-progress-linear.component';
import { UserService } from '../../services/user.service';

@Component({
    selector: 'app-register',
    imports: [MaterialInputComponent, MaterialButtonComponent, FormsModule, MaterialProgressLinearComponent],
    templateUrl: './register.component.html',
    styleUrl: './register.component.scss'
})
export class RegisterComponent {
  @Output() onSuccess = new EventEmitter<{ uniqName: string, password: string }>();

  uniqName = signal('');
  password = signal('');
  password2 = signal('');
  uniqNameHint = signal('');
  passwordHint = signal('');
  isUniqNameVld = signal(false);
  isPwdVld = signal(false);
  resp = signal('');
  isReging = signal(false)
  isRegBtnDisabled = computed(() => {
    return this.isSuccess() || this.isReging() || this.isUniqNameVld() === false || this.isPwdVld() === false
  })
  isSuccess = signal(false)
  MaterialButtonType = MaterialButtonType
  /*^ Start of string
    (?=[\w.-]{5,20}$) Assert 5-20 of the allowed characters
    (?:[\d_.-]*[a-zA-Z]){3} Match 3 times a-zA-Z followed by optional digits _ . -
    [\w.-]* Match optional word chars or . or -
    $ End of string
  */
  private _uniqNameRegex = /^(?=[\w.-]{1,20}$)(?:[\d_.-]*[a-zA-Z]){3}[\w.-]*$/
  private _passwordRegx: RegExp = /^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/;
  constructor(private userService: UserService,) {
    effect(() => {
      const uniqname = this.uniqName()
      if (!this._uniqNameRegex.test(uniqname)) {
        this.isUniqNameVld.set(false)
        this.uniqNameHint.set('1 to 20 letters/numbers')
      } else {
        this.isUniqNameVld.set(true)
        this.uniqNameHint.set('')
      }
    }, { allowSignalWrites: true })
    effect(() => {
      const password = this.password()
      if (!this._passwordRegx.test(password)) {
        this.isPwdVld.set(false)
        this.passwordHint.set('6 to 20 letters/numbers/symbols')
      } else {
        this.isPwdVld.set(true)
        this.passwordHint.set('')
      }
    }, { allowSignalWrites: true })
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
        next: ({ status, message }) => {
          if (status === 0) {
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
          this.resp.set('unknow error occured')
          this.isReging.set(false)
        }
      })
  }
}
