import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MsgService } from '../../../services/message.service'
import { MsgThread, User } from '../../../services/Interfaces'

@Component({
  selector: 'app-thread-list',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './thread-list.component.html',
  styleUrl: './thread-list.component.scss'
})
export class ThreadListComponent {
  threadList: MsgThread[] = []
  userInfoDict: Record<string, User> = {}
  profile: User = {} as User

  constructor(private msgService: MsgService) { }

  getThreadList() {
    return this.msgService.getThreadList().subscribe(threadList => {
      this.threadList = threadList
    })
  }

  getUserList() {
    return this.msgService.getUserList().subscribe(userList => {
      userList.map(item => {
        this.userInfoDict[item.id] = item
      })
    })
  }

  getMyInfo() {
    return this.msgService.getMyProfile().subscribe(profile => {
      this.profile = profile
    })
  }

  getUserName(item: MsgThread) {
    const { userId1, userId2 } = item.threadItem.info;
    let userId = userId1;
    if (userId1 === this.profile.id) {
      userId = userId2;
    }
    return this.userInfoDict[userId]?.uniqName
  }

  ngOnInit() {
    this.getThreadList();
    this.getUserList();
    this.getMyInfo();
  }
}
