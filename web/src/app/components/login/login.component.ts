import { Component, signal, input } from '@angular/core';
import { AuthService } from '../../services/auth.service'
import { UserAvatarComponent, UserAvatarType } from '../../components/user-avatar/user-avatar.component';
import { MaterialInputComponent } from '../material-input/material-input.component';
import { MaterialButtonComponent, MaterialButtonType } from "../material-button/material-button.component";
import { Subject } from 'rxjs';
import { ComponentEventSubject } from '../../../utils'
import { HttpErrorResponse } from '@angular/common/http'
import { MaterialCheckboxComponent } from '../material-checkbox/material-checkbox.component';
export enum LoginEvent {
  SUCCESS, INVALID, ERROR
}
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [UserAvatarComponent, MaterialInputComponent, MaterialCheckboxComponent,
    MaterialButtonComponent],
  providers: [AuthService],
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

  constructor(private authService: AuthService) {
  }

  login() {
    this.authService.login({ username: this.uniqName(), password: this.password() })
      .subscribe({
        next: res => {
          this.authService.setToken(res.access_token, res.refresh_token, this.isKeepLogin())
          this.subject()?.next({
            event: LoginEvent.SUCCESS,
          })
        },
        error: (err) => {
          if (err instanceof HttpErrorResponse && err.status === 401) {
            this.resp.set('error username/password')
          } else {
            console.error(err)
            this.resp.set('error occured')
          }
        }
      })
  }

  register() {
    this.authService.register({ username: this.uniqName(), password: this.password() })
      .subscribe({
        next: res => {
          this.resp.set(res.access_token); localStorage.setItem('token', res.access_token)
          this.subject()?.next({
            event: LoginEvent.SUCCESS,
          })
        },
        error: (err) => {
          if (err instanceof HttpErrorResponse && err.status === 401) {
            this.resp.set('error username/password')
          } else {
            console.error(err)
            this.resp.set('error occured')
          }
        }
      })

  }
}
