import { Component, input, signal, computed, EventEmitter, Output } from '@angular/core';
import { NgClass } from '@angular/common';
import { UserService } from '../../services/user.service'
import { User, UserMessageThread } from '../../services/model'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { ChatFolder, inFolder } from '../../services/folder.service'

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
  /** active folder; undefined = no folder filter (show all) */
  readonly folder = input<ChatFolder | undefined>(undefined)
  /** local name search; '' = no filter. */
  readonly searchText = input('')
  readonly threadList = signal<UserMessageThread[]>([])

  /** view model after applying the folder + search filters. */
  readonly filteredThreadList = computed(() => {
    const folder = this.folder(), q = this.searchText().trim().toLowerCase()
    return this.threadList().filter(t => {
      if (folder && !inFolder(t, folder)) return false
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
    // take:200 — folders must filter over the full thread set, not the first page.
    // (true infinite scroll is a follow-up; 200 covers personal thread counts.)
    return this.userService.queryUserThreadValid({ take: 200, skip: 0 }).subscribe(res => {
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
