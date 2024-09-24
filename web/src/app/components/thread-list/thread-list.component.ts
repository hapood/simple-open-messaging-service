import { Component, input, signal, EventEmitter, Output } from '@angular/core';
import { NgClass } from '@angular/common';
import { UserService } from '../../services/user.service'
import { User } from '../../services/model'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { switchMap, of, forkJoin } from 'rxjs';

interface DispThreadItem { id: number, userId: number, name: string, icon: string }
@Component({
  selector: 'app-thread-list',
  standalone: true,
  imports: [UserAvatarComponent, NgClass],
  templateUrl: './thread-list.component.html',
  styleUrl: './thread-list.component.scss'
})
export class ThreadListComponent {
  UserAvatarType = UserAvatarType
  readonly profile = input<User>()
  readonly selectedId = input<number>()
  readonly threadList = signal<DispThreadItem[]>([])

  @Output() onSelect = new EventEmitter<number>()

  userInfoDict = signal<Record<string, User>>({})

  constructor(private userService: UserService) { }

  genThreadList() {
    return this.userService.queryUserThreadValid({ take: 10, skip: 0 }).subscribe(res => {
      if (res.status == 0) {

      } else {
        throw new Error(res.message)
      }
    })
  }

  onUsrTrdClick(userTrd: DispThreadItem) {
    this.onSelect.emit(userTrd.id)
  }

  ngOnInit() {
    this.genThreadList();
  }
}
