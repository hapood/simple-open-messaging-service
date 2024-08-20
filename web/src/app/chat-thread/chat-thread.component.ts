import { Component, HostListener } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule, FormControl, ReactiveFormsModule } from '@angular/forms';
import { ChatService, } from '../../services/chat.service'
import { Input as RouterInput } from '@angular/core'
import { Message, User, ChatThread, } from '../../services/Interfaces';
import { forkJoin, timeout, finalize } from "rxjs";

const TAKE_NUM = 10;
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

  profile: User | Record<string, undefined> = {}
  friendProfile: User | Record<string, undefined> = {}
  userChatThread: ChatThread | Record<string, undefined> = {}
  isReady = false
  isChatScrollerSet = false
  oldestChatId: number | undefined = undefined
  hasMoreOldChat = true
  isLoadingOld = false
  isLoadingNew = false
  latestChatId: number | undefined = undefined

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

  syncNewChatLog() {
    if (this.isLoadingNew) return
    this.isLoadingNew = true;
    const params = {
      threadId: parseInt(this.id),
      orderBy: 'asc' as 'asc',
      take: TAKE_NUM,
      skip: 1,
      lastId: this.latestChatId
    }
    if (!this.latestChatId) {
      params.skip = 0;
    }
    return this.chatService.queryMessageLog(params)
      .pipe(
        timeout(2500)
      ).pipe(
        finalize(() => this.isLoadingNew = false),
      )
      .subscribe({
        next: list => {
          this.latestChatId = list[list.length - 1].id
          this.messageList = this.messageList.concat(list)
        }, error: err => console.error(err)
      })
  }

  initChatLog() {
    this.isLoadingOld = true;
    return this.chatService.queryMessageLog({
      threadId: parseInt(this.id), orderBy: 'desc',
      take: TAKE_NUM, skip: 0
    })
      .pipe(
        timeout(2500)
      ).pipe(
        finalize(() => this.isLoadingOld = false),
      )
      .subscribe({
        next: list => {
          if (list.length > 0) {
            const latestChat = list[0];
            this.latestChatId = latestChat.id;
            const rList = list.reverse();
            const oldestChat = rList[0];
            this.oldestChatId = oldestChat.id;
            this.messageList = rList;
          }
          if (list.length < TAKE_NUM) {
            this.hasMoreOldChat = false
          }
        }, error: err => console.error(err)
      })
  }

  getName(userId: number) {
    if (this.profile.id === userId) {
      return this.profile.uniqName
    } else {
      return this.friendProfile.uniqName;
    }
  }

  getClassName(userId: number) {
    if (this.profile.id === userId) {
      return 'chat-self'
    } else {
      return 'chat-friend'
    }
  }
  initThreadInfo() {
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
        this.chatService.queryFriendInfo({ userId: friendId }).subscribe(res => {
          this.friendProfile = res.friendUser
          this.isReady = true
        })
      })
  }

  ngOnInit() {
    this.initThreadInfo()
    this.initChatLog()
  }

  loadMoreOldChat() {
    if (this.isLoadingOld || !this.hasMoreOldChat) return
    this.isLoadingOld = true;
    return this.chatService.queryMessageLog({
      threadId: parseInt(this.id), take: TAKE_NUM, skip: 1,
      lastId: this.oldestChatId, orderBy: 'desc'
    }).pipe(
      timeout(2500)
    )
      .pipe(
        finalize(() => this.isLoadingOld = false),
      )
      .subscribe(list => {
        const rList = list.reverse();
        const latestChat = rList[0];
        this.oldestChatId = latestChat.id;
        this.messageList = rList.concat(this.messageList)
        if (list.length < TAKE_NUM) {
          this.hasMoreOldChat = false
        }
      })
  }

  @HostListener('window:scroll', ['$event'])
  onScroll(event: any) {
    if (window.scrollY < 20) {
      this.loadMoreOldChat()
    }
  }

  ngAfterViewChecked() {
    if (!this.isChatScrollerSet && this.messageList.length > 0) {
      this.isChatScrollerSet = true;
      window.scrollTo(0, document.body.scrollHeight);
    }
  }

}
