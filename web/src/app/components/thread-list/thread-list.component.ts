import { Component, input, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { MsgService } from '../../services/message.service'
import { MsgThread, User } from '../../services/Interfaces'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
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

  readonly threadList = signal<MsgThread[]>([])
  readonly selectedId = signal<number | undefined>(undefined)

  userInfoDict = signal<Record<string, User>>({})

  constructor(private msgService: MsgService, private route: ActivatedRoute, private router: Router) { }

  getThreadList() {
    return this.msgService.getThreadList().subscribe(threadList => {
      this.threadList.set(threadList)
    })
  }

  getUserList() {
    return this.msgService.getUserList().subscribe(userList => {
      const dict: Record<string, User> = {}
      userList.map(item => {
        dict[item.id] = item
      })
      this.userInfoDict.set(dict)
    })
  }

  onThreadClick(thread: MsgThread) {
    this.selectedId.set(thread.id)
    this.route.url.subscribe(urls => {
      let replaceUrl = true
      if (urls.length === 0) {
        replaceUrl = false
      } this.router.navigate(['/thread/', thread.id], { replaceUrl });

    })
  }

  getUserName(item: MsgThread) {
    const { userId1, userId2 } = item.threadItem.info;
    let userId = userId1;
    if (userId1 === this.profile()?.id) {
      userId = userId2;
    }
    return this.userInfoDict()[userId]?.uniqName
  }

  ngOnInit() {
    this.getThreadList();
    this.getUserList();
  }
}
