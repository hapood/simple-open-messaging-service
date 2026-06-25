import { Component, signal, computed, Output, EventEmitter } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service'
import { UserAvatarComponent, UserAvatarType } from '../../components/user-avatar/user-avatar.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';

export enum LoginEvent {
  SUCCESS, INVALID, ERROR, JUMP_TO_REGISTER
}

@Component({
    selector: 'app-login',
    imports: [UserAvatarComponent, FormsModule, MatButtonModule, MatCheckboxModule,
        MatFormFieldModule, MatInputModule, MatProgressBarModule],
    templateUrl: './login.component.html',
    styleUrl: './login.component.scss'
})
export class LoginComponent {
  @Output() onSuccess = new EventEmitter<boolean>();

  uniqName = signal('');
  password = signal('');
  resp = signal('');
  UserAvatarType = UserAvatarType
  isKeepLogin = signal(true)
  isLoging = signal(false)
  isSuccess = signal(false)
  isLoginBtnDisabled = computed(() => {
    return this.isSuccess() || this.isLoging() || this.uniqName() === '' || this.password() === ''
  })

  constructor(private authService: AuthService, private routeService: RouteService) {

  }

  login() {
    if (this.isLoging()) {
      return
    }
    this.isLoging.set(true)
    this.authService.login({
      uniqName: this.uniqName(),
      password: this.password(), isKeep: this.isKeepLogin()
    })
      .subscribe({
        next: ({ code, message }) => {
          if (code === 0) {
            this.onSuccess.emit(true)
            this.isSuccess.set(true)
            this.isLoging.set(false)
          } else {
            this.resp.set(message)
            this.isLoging.set(false)
          }
        },
        error: (err) => {
          console.error(err)
          this.resp.set('unknow error occured')
          this.isLoging.set(false)
        }
      })
  }

  jumpToRegister() {
    this.routeService.navigate(RoutePage.AUTH_REGISTER)
  }
}
