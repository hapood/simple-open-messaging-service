import { Component, signal, computed, Output, EventEmitter } from '@angular/core';
import { AuthService } from '../../services/auth.service'
import { UserAvatarComponent, UserAvatarType } from '../../components/user-avatar/user-avatar.component';
import { MaterialInputComponent } from '../material-input/material-input.component';
import { MaterialButtonComponent, MaterialButtonType } from "../material-button/material-button.component";
import { MaterialCheckboxComponent } from '../material-checkbox/material-checkbox.component';
import { RouteService, RoutePage } from '../../services/route.service';
import { MaterialProgressLinearComponent } from "../material-progress-linear/material-progress-linear.component";

export enum LoginEvent {
  SUCCESS, INVALID, ERROR, JUMP_TO_REGISTER
}

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [UserAvatarComponent, MaterialInputComponent, MaterialCheckboxComponent,
    MaterialButtonComponent, MaterialProgressLinearComponent],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent {
  @Output() onSuccess = new EventEmitter<boolean>();

  uniqName = signal('');
  password = signal('');
  resp = signal('');
  UserAvatarType = UserAvatarType
  MaterialButtonType = MaterialButtonType
  isKeepLogin = signal(true)
  isLoging = signal(false)
  isLoginBtnDisabled = computed(() => {
    return this.isLoging() || this.uniqName() === '' || this.password() === ''
  })

  constructor(private authService: AuthService, private routeService: RouteService) {

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
            this.onSuccess.emit(true)
          } else {
            this.resp.set(message)
            this.isLoging.set(false)
          }
        },
        error: (err) => {
          console.error(err)
          this.resp.set('error occured')
          this.isLoging.set(false)
        }
        , complete: () => {
        }
      })
  }

  jumpToRegister() {
    this.routeService.navigate(RoutePage.AUTH_REGISTER)
  }
}
