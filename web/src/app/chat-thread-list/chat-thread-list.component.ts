import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ChatService } from '../../services/chat.service'
import { ChatThread, User } from '../../services/Interfaces'

@Component({
  selector: 'app-chat-thread-list',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './chat-thread-list.component.html',
  styleUrl: './chat-thread-list.component.scss'
})
export class ChatThreadListComponent {
  threadList: ChatThread[] = []
  userInfoDict: Record<string, User> = {}
  profile: User = {} as User

  constructor(private chatService: ChatService) { }

  getThreadList() {
    return this.chatService.getChatThreadList().subscribe(threadList => {
      this.threadList = threadList
    })
  }

  getUserList() {
    return this.chatService.getUserList().subscribe(userList => {
      userList.map(item => {
        this.userInfoDict[item.id] = item
      })
    })
  }

  getMyInfo() {
    return this.chatService.getMyProfile().subscribe(profile => {
      this.profile = profile
    })
  }

  getUserName(item: ChatThread) {
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
