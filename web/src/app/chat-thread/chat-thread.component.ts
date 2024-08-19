import { Component } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule, FormControl, ReactiveFormsModule } from '@angular/forms';
import { ChatService, } from '../../services/chat.service'
import { Input as RouterInput } from '@angular/core'
import { Message, User, ChatThread } from '../../services/Interfaces';
import { forkJoin } from "rxjs";

@Component({
  selector: 'app-chat-thread',
  standalone: true,
  imports: [FormsModule, NgClass, ReactiveFormsModule],
  templateUrl: './chat-thread.component.html',
  styleUrl: './chat-thread.component.scss'
})
export class ChatThreadComponent {
  inputTextControl = new FormControl('');

  @RouterInput() id!: string;

  messageList: Message[] = []
  constructor(private chatService: ChatService) { }

  profile: User = {} as User
  friendProfile: User = {} as User
  userChatThread: ChatThread = {} as ChatThread
  isReady = false

  send() {
    const content = this.inputTextControl.value
    if (content) {
      return this.chatService.sendMessage({ threadId: parseInt(this.id), content })
        .subscribe(res => {
          this.inputTextControl.setValue('')
        })
    } else {
      alert('can not send empty')
      return false
    }
  }

  queyChatLog() {
    return this.chatService.queryMessageLog({ threadId: parseInt(this.id), take: 20, skip: 0 })
      .subscribe(list => this.messageList = list)
  }

  getName(userId: number) {
    if (this.profile.id === userId) {
      return this.profile.uniqName
    } else {
      return this.friendProfile.uniqName
    }
  }
  getClassName(userId: number) {
    if (this.profile.id === userId) {
      return 'chat-self'
    } else {
      return 'chat-friend'
    }
  }
  ngOnInit() {
    const getChatThreadInfo$ = this.chatService.getChatThreadInfo({
      threadId: parseInt(this.id)
    })
    const getMyInfo$ = this.chatService.getMyProfile()
    forkJoin([getChatThreadInfo$, getMyInfo$])
      .subscribe(([chatThread, profile]) => {
        this.userChatThread = chatThread
        this.profile = profile
        const { userId1, userId2 } = chatThread.threadItem.info
        const friendId = userId1 === profile.id ? userId2 : userId1
        this.chatService.queryFriendInfo({ userId: friendId }).subscribe(profile => {
          this.friendProfile = profile
          this.isReady = true
        })
      })
    this.queyChatLog()
  }
}
