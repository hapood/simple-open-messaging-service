import { Component, signal } from '@angular/core';
import { UserLoginService } from '../../../common/services/user-login.service'
import { FormsModule } from '@angular/forms';
import { UserAvatarComponent } from '../../../components/user-avatar/user-avatar.component';
import { UserAvatarType } from '../../../components/user-avatar/modal';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, UserAvatarComponent],
  providers: [UserLoginService],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent {
  uniqName = signal('')
  password = signal('');
  resp = signal('');
  UserAvatarType = UserAvatarType

  constructor(private userLoginService: UserLoginService) { }

  login() {
    return this.userLoginService.login({ username: this.uniqName(), password: this.password() })
      .subscribe(res => { this.resp.set(res.access_token); localStorage.setItem('token', res.access_token) })
  }
}
