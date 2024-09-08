import { Component, signal, input } from '@angular/core';
import { AuthService } from '../../services/auth.service'
import { UserAvatarComponent, UserAvatarType } from '../../components/user-avatar/user-avatar.component';
import { MaterialInputComponent } from '../material-input/material-input.component';
import { MaterialButtonComponent, MaterialButtonType } from "../material-button/material-button.component";
import { Subject } from 'rxjs';
import { ComponentEventSubject } from '../../../utils'
import { MaterialCheckboxComponent } from '../material-checkbox/material-checkbox.component';
export enum LoginEvent {
  SUCCESS, INVALID, ERROR, JUMP_TO_REGISTER
}

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [UserAvatarComponent, MaterialInputComponent, MaterialCheckboxComponent,
    MaterialButtonComponent],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent {
  subject = input<Subject<ComponentEventSubject<LoginEvent>> | undefined>()
  uniqName = signal('')
  password = signal('');
  resp = signal('');
  UserAvatarType = UserAvatarType
  MaterialButtonType = MaterialButtonType
  isKeepLogin = signal(true)
  isLoging = signal(false)

  constructor(private authService: AuthService) {
  }

  login() {
    if (this.isLoging()) {
      return
    }
    this.isLoging.set(true)
    this.authService.login({ uniqName: this.uniqName(), password: this.password(), isKeep: this.isKeepLogin() })
      .subscribe({
        next: ({ status, message }) => {
          if (status === 0) {
            this.subject()?.next({
              event: LoginEvent.SUCCESS,
            })
          } else {
            this.resp.set(message)
            this.subject()?.next({
              event: LoginEvent.INVALID,
            })
          }
        },
        error: (err) => {
          console.error(err)
          this.resp.set('error occured')
          this.subject()?.next({
            event: LoginEvent.ERROR,
          })
        }
        , complete: () => {
          this.isLoging.set(false)
        }
      })
  }

  jumpToRegister() {
    this.subject()?.next({
      event: LoginEvent.JUMP_TO_REGISTER,
    })
  }
}
