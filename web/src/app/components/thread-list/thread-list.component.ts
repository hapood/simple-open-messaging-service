import { Component, input, signal, computed, EventEmitter, Output } from '@angular/core';
import { NgClass } from '@angular/common';
import { UserService } from '../../services/user.service'
import { User, UserMessageThread } from '../../services/model'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';

export type ThreadFilterType = 'ALL' | 'P2P' | 'GROUP'

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
  /** type filter; ALL = no filter. Mobile doesn't pass it → stays ALL. */
  readonly filterType = input<ThreadFilterType>('ALL')
  /** local name search; '' = no filter. */
  readonly searchText = input('')
  readonly threadList = signal<UserMessageThread[]>([])

  /** view model after applying the type + search filters. */
  readonly filteredThreadList = computed(() => {
    const filter = this.filterType(), q = this.searchText().trim().toLowerCase()
    return this.threadList().filter(t => {
      if (filter !== 'ALL' && t.toObjType !== filter) return false
      if (q) {
        const name = (t.toObjType === 'P2P' ? t.userItem?.uniqName : t.groupItem?.name) ?? ''
        if (!name.toLowerCase().includes(q)) return false
      }
      return true
    })
  })

  @Output() onSelect = new EventEmitter<UserMessageThread>()

  constructor(private userService: UserService) { }

  genThreadList() {
    return this.userService.queryUserThreadValid({ take: 10, skip: 0 }).subscribe(res => {
      if (res.code == 0) {
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
