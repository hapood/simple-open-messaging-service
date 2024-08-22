import { Component } from '@angular/core';
import { UserLoginService } from '../../services/user-login.service'
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-user-login',
  standalone: true,
  imports: [FormsModule],
  providers: [UserLoginService],
  templateUrl: './user-login.component.html',
  styleUrl: './user-login.component.scss'
})
export class UserLoginComponent {
  uniqName = "hapood"
  password = "512512";
  resp = ""

  constructor(private userLoginService: UserLoginService) { }

  login() {
    return this.userLoginService.login({ username: this.uniqName, password: this.password })
      .subscribe(res => { this.resp = res.access_token; localStorage.setItem('token', res.access_token) })
  }
}
