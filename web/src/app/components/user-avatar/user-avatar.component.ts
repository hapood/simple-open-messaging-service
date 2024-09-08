import { Component, input } from '@angular/core';
import { UserAvatarType } from './model'

@Component({
  selector: 'app-user-avatar',
  standalone: true,
  imports: [],
  templateUrl: './user-avatar.component.html',
  styleUrl: './user-avatar.component.scss'
})

export class UserAvatarComponent {
  readonly type = input<UserAvatarType>()
  readonly UserAvatarType = UserAvatarType
}

export { UserAvatarType } from './model'