import { Component, signal, Output, EventEmitter } from '@angular/core';
import { UserLoginService } from '../../services/user-login.service'
import { UserAvatarComponent } from '../../components/user-avatar/user-avatar.component';
import { UserAvatarType } from '../../components/user-avatar/modal';
import { MaterialInputComponent } from '../material-input/material-input.component';
import { MaterialButtonComponent } from "../material-button/material-button.component";
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [UserAvatarComponent, MaterialInputComponent, MaterialButtonComponent],
  providers: [UserLoginService],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent {
  @Output() onSuccess = new EventEmitter();
  uniqName = signal('')
  password = signal('');
  resp = signal('');
  UserAvatarType = UserAvatarType

  constructor(private userLoginService: UserLoginService) { }

  login() {
    // return this.userLoginService.login({ username: this.uniqName(), password: this.password() })
    //   .subscribe(res => {
    //     this.resp.set(res.access_token); localStorage.setItem('token', res.access_token)
    //     this.onSuccess.emit()
    //   })
  }
}
