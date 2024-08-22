import { Component, HostListener } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule, FormControl, ReactiveFormsModule } from '@angular/forms';
import { ChatService, } from '../../services/chat.service'
import { Input as RouterInput } from '@angular/core'
import { Message, User, ChatThread, QueryMessageLogParams, } from '../../services/Interfaces';
import { Subscription, forkJoin, timeout, finalize, Subject, filter, mergeMap, tap, switchMap, catchError, of } from "rxjs";
import { SendingMessage, SentMessage, SendingMessageStatus } from './interfaces';
import { arrayToDictIndex } from '../../utils'

const TAKE_NUM = 10;
const LOAD_MORE_TRIGGER_OFFSET = innerHeight / 10;
const WAIT_FOR_RENDER_INTERVAL = 10;

@Component({
  selector: 'app-chat-thread',
  standalone: true,
  imports: [FormsModule, NgClass, ReactiveFormsModule],
  templateUrl: './chat-thread.component.html',
  styleUrl: './chat-thread.component.scss'
})

export class ChatThreadComponent {
  constructor(private chatService: ChatService) {
  }

  @RouterInput() id!: string;

  inputTextControl = new FormControl<string>('');
  messageList: Message[] = [];
  sendingMessageList: SendingMessage[] = []
  sentMessageList: SentMessage[] = []
  failedMessageList: SendingMessage[] = []
  isReady = false
  hasMoreOldChat = true
  isLoadingNew = false
  isLoadingOld = false

  private userChatThread: ChatThread | Record<string, undefined> = {}
  private queryOldMessages = new Subject<QueryMessageLogParams>()
  private subOldMessages!: Subscription;
  private queryNewMessages = new Subject<QueryMessageLogParams>()
  private subNewMessages!: Subscription;
  private newestChatId: number | undefined = undefined
  private oldestChatId: number | undefined = undefined
  private profile: User | Record<string, undefined> = {}
  private friendProfile: User | Record<string, undefined> = {}
  private isBottom = true
  private hasMoreNewChat = false
  private sentTempId = 0;

  send() {
    const content = this.inputTextControl.value
    if (content) {
      const currentId = this.sentTempId
      return this.chatService.sendMessage({ threadId: parseInt(this.id), content }).pipe(
        tap(() => {
          this.sendingMessageList.push({
            id: currentId,
            content: this.inputTextControl.value as string
          })
          this.inputTextControl.setValue('')
          this.sentTempId++
        }))
        .subscribe(
          {
            next: (res) => {
              this.updateSendMessageStatus(currentId, SendingMessageStatus.SENT, { dbId: res.id })
              this.hasMoreNewChat = true
              this.loadMoreNewChat()
            },
            error: (error) => {
              console.error(error)
              this.updateSendMessageStatus(currentId, SendingMessageStatus.FAILED)
            }
          })
    } else {
      return false
    }
  }

  updateSendMessageStatus(sendId: number, status: SendingMessageStatus, options?: { dbId?: string }) {
    let index = this.sendingMessageList.findIndex(item => item.id === sendId);
    if (index) {
      const msg = this.sendingMessageList[index]
      this.sendingMessageList.splice(index)
      switch (status) {
        case SendingMessageStatus.FAILED:
          this.failedMessageList.push(msg)
          break;
        case SendingMessageStatus.SENT:
          this.sentMessageList.push({ ...msg, dbId: (options as any).dbId })
          break;
      }
    }
  }

  mergeSentMessages(list: Message[]) {
    const dict = arrayToDictIndex(this.sentMessageList.
      map((stMsg, index) => ({ dbId: stMsg.dbId, index })), 'dbId')
    const filterDict: Record<number, true> = {}
    list.forEach(item => {
      const dictItem = dict[item.id]
      if (dictItem) {
        filterDict[dictItem.index] = true
      }
    })
    this.sentMessageList = this.sentMessageList.filter((_, index) => !filterDict[index])
  }

  loadMoreNewChat() {
    this.queryNewMessages.next({
      threadId: parseInt(this.id),
      orderBy: 'asc' as 'asc',
      take: TAKE_NUM,
      skip: 1,
      lastId: this.newestChatId
    })
  }

  loadMoreOldChat() {
    this.queryOldMessages.next({
      threadId: parseInt(this.id), take: TAKE_NUM, skip: 1,
      lastId: this.oldestChatId, orderBy: 'desc'
    })
  }

  initChatLog() {
    return this.chatService.queryMessageLog({
      threadId: parseInt(this.id), orderBy: 'desc',
      take: TAKE_NUM, skip: 0
    })
      .pipe(
        tap(() => this.isLoadingOld = true),
        finalize(() => this.isLoadingOld = false),
        timeout(2500)
      )
      .subscribe({
        next: list => {
          if (list.length > 0) {
            const latestChat = list[0];
            this.newestChatId = latestChat.id;
            const rList = list.reverse();
            const oldestChat = rList[0];
            this.oldestChatId = oldestChat.id;
            this.messageList = rList;
            this.mergeSentMessages(list)
          }
          if (list.length < TAKE_NUM) {
            this.hasMoreOldChat = false
          }
          setTimeout(this.scrollToBottom, WAIT_FOR_RENDER_INTERVAL)
        },
        error: err => console.error(err)
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
    const getChatThreadInfo = this.chatService.getChatThreadInfo({
      threadId: parseInt(this.id)
    })
    const getMyInfo = this.chatService.getMyProfile()
    forkJoin([getChatThreadInfo, getMyInfo]).pipe(mergeMap(([chatThread, profile]) => {
      this.userChatThread = chatThread
      this.profile = profile
      const { userId1, userId2 } = chatThread.threadItem.info
      const friendId = userId1 === profile.id ? userId2 : userId1
      return this.chatService.queryFriendInfo({ userId: friendId })
    })).subscribe(res => {
      this.friendProfile = res.friendUser
      this.isReady = true
    })
  }

  ngOnInit() {
    this.initThreadInfo()
    this.initChatLog()
    this.subOldMessages = this.queryOldMessages
      .pipe(
        filter(() => !this.isLoadingOld),
        switchMap((params) => this.chatService.queryMessageLog(params).pipe(
          tap(() => this.isLoadingOld = true),
          timeout(2500),
          finalize(() => this.isLoadingOld = false),
          catchError((error) => {
            console.log(error)
            return of([])
          }))
        ))
      .subscribe(list => {
        const rList = list.reverse();
        const latestChat = rList[0];
        this.oldestChatId = latestChat.id;
        this.messageList = rList.concat(this.messageList)
        if (list.length < TAKE_NUM) {
          this.hasMoreOldChat = false
        }
      })
    this.subNewMessages = this.queryNewMessages
      .pipe(
        filter(() => !this.isLoadingNew),
        switchMap((params) => this.chatService.queryMessageLog(params).pipe(
          timeout(2500),
          tap(() => this.isLoadingNew = true),
          finalize(() => this.isLoadingNew = false),
          catchError((error) => {
            console.log(error)
            return of([])
          }))
        ),
        filter((list) => list.length > 0))
      .subscribe({
        next: list => {
          this.newestChatId = list[list.length - 1].id
          this.messageList = this.messageList.concat(list)
          if (list.length < TAKE_NUM) {
            this.hasMoreNewChat = false
          } else {
            this.hasMoreNewChat = true
          }
          this.isLoadingNew = false
          if (this.isBottom) {
            setTimeout(this.scrollToBottom, WAIT_FOR_RENDER_INTERVAL)
          }
        }
      })
  }

  ngOnDestroy() {
    this.subNewMessages.unsubscribe();
    this.subOldMessages.unsubscribe();
  }

  @HostListener('window:scroll', ['$event'])
  onScroll(event: any) {
    if (window.scrollY < LOAD_MORE_TRIGGER_OFFSET && this.hasMoreOldChat) {
      this.loadMoreOldChat()
    } else if (window.scrollY > document.body.scrollHeight - LOAD_MORE_TRIGGER_OFFSET && this.hasMoreNewChat) {
      this.loadMoreNewChat()
    }
    if ((innerHeight + scrollY) >= document.body.scrollHeight) {
      this.isBottom = true;
    } else {
      this.isBottom = false;
    }
  }

  scrollToBottom() {
    window.scrollTo(0, document.body.scrollHeight);
  }

}
