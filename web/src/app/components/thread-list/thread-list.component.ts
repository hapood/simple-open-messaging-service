import { Component, input, signal, EventEmitter, Output } from '@angular/core';
import { NgClass } from '@angular/common';
import { UserService } from '../../services/user.service'
import { User, UserMessageThread } from '../../services/model'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';

@Component({
    selector: 'app-thread-list',
    imports: [UserAvatarComponent, NgClass],
    templateUrl: './thread-list.component.html',
    styleUrl: './thread-list.component.scss'
})
export class ThreadListComponent {
  UserAvatarType = UserAvatarType
  readonly profile = input<User>()
  readonly selectedId = input<number>()
  readonly threadList = signal<UserMessageThread[]>([])

  @Output() onSelect = new EventEmitter<UserMessageThread>()

  constructor(private userService: UserService) { }

  genThreadList() {
    return this.userService.queryUserThreadValid({ take: 10, skip: 0 }).subscribe(res => {
      if (res.status == 0) {
        this.threadList.set(res.data!)
      } else {
        throw new Error(res.message)
      }
    })
  }

  onUsrTrdClick(userMsgTrd: UserMessageThread) {
    this.onSelect.emit(userMsgTrd)
  }

  ngOnInit() {
    this.genThreadList();
  }
}
