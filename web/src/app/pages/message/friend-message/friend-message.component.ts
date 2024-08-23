import { Component, HostBinding, ElementRef, model, signal, viewChild, Input } from '@angular/core';
import { CommonModule, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MsgService, } from '../../../common/services/message.service'
import { Input as RouterInput } from '@angular/core'
import { Message, User, MsgThread, QueryMessageLogParams, } from '../../../common/services/Interfaces';
import {
  Subscription, forkJoin, timeout, finalize,
  Subject, filter, mergeMap, tap, switchMap, catchError, of,
  delay
} from "rxjs";
import { SendingMessage, SentMessage, SendingMessageStatus } from './interfaces';
import { arrayToDictIndex, arraySignal } from '../../../../utils'

const TAKE_NUM = 10;
const WAIT_FOR_RENDER_INTERVAL = 100;
const LOAD_MORE_TRIGGER_OFFSET = 100;

@Component({
  selector: 'app-friend-message',
  standalone: true,
  imports: [CommonModule, FormsModule, NgClass],
  templateUrl: './friend-message.component.html',
  styleUrl: './friend-message.component.scss'
})

export class FriendMessageComponent {
  constructor(private msgService: MsgService) {
  }
  @HostBinding("style.--color")
  @Input() color: string;

  @RouterInput() id!: string;
  readonly userInput = viewChild<ElementRef<HTMLInputElement>>('userInput');
  readonly msgScroller = viewChild<ElementRef<HTMLDivElement>>('msgScroller');

  readonly inputText = model('inputText');
  readonly messageList = arraySignal<Message>([]);
  readonly sendingMessageList = arraySignal<SendingMessage>([])
  readonly sentMessageList = arraySignal<SentMessage>([])
  readonly failedMessageList = arraySignal<SendingMessage>([])
  readonly topMessageList = arraySignal<Message>([])
  readonly isReady = signal(false)
  readonly hasMoreOldMsg = signal(true)
  readonly isLoadingNew = signal(false)
  readonly isLoadingOld = signal(false)

  private msgThread: MsgThread | Record<string, undefined> = {}
  private queryOldMessages = new Subject<QueryMessageLogParams>()
  private subOldMessages!: Subscription;
  private queryNewMessages = new Subject<QueryMessageLogParams>()
  private subNewMessages!: Subscription;
  private newestMsgId: number | undefined = undefined
  private oldestMsgId: number | undefined = undefined
  private profile: User | Record<string, undefined> = {}
  private friendProfile: User | Record<string, undefined> = {}
  private isBottom = true
  private hasMoreNewMsg = false
  private sentTempId = 0;
  private inputObserver!: ResizeObserver;
  private scrollObserver!: MutationObserver;

  send() {
    const content = this.inputText()
    if (content) {
      const currentId = this.sentTempId
      return this.msgService.sendMessage({ threadId: parseInt(this.id), content }).pipe(
        tap(() => {
          this.sendingMessageList.push({
            id: currentId,
            content
          })
          this.inputText.set('')
          this.sentTempId++
        }))
        .subscribe(
          {
            next: (res) => {
              this.updateSendMessageStatus(currentId, SendingMessageStatus.SENT, { dbId: res.id })
              this.hasMoreNewMsg = true
              this.loadMoreNewMsg()
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
    const list = this.sendingMessageList()
    let index = list.findIndex(item => item.id === sendId);
    if (index) {
      const msg = list[index]
      list.splice(index)
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
    const dict = arrayToDictIndex(this.sentMessageList().
      map((stMsg, index) => ({ dbId: stMsg.dbId, index })), 'dbId')
    const filterDict: Record<number, true> = {}
    list.forEach(item => {
      const dictItem = dict[item.id]
      if (dictItem) {
        filterDict[dictItem.index] = true
      }
    })
    this.sentMessageList.filter((_, index) => !filterDict[index])
  }

  loadMoreNewMsg() {
    this.queryNewMessages.next({
      threadId: parseInt(this.id),
      orderBy: 'asc' as 'asc',
      take: TAKE_NUM,
      skip: 1,
      lastId: this.newestMsgId
    })
  }

  loadMoreOldMsg() {
    this.queryOldMessages.next({
      threadId: parseInt(this.id), take: TAKE_NUM, skip: 1,
      lastId: this.oldestMsgId, orderBy: 'desc'
    })
  }

  initMsgLog() {
    return this.msgService.queryMessageLog({
      threadId: parseInt(this.id), orderBy: 'desc',
      take: TAKE_NUM, skip: 0
    })
      .pipe(
        tap(() => this.isLoadingOld.set(true)),
        finalize(() => this.isLoadingOld.set(false)),
        timeout(2500)
      )
      .subscribe({
        next: list => {
          if (list.length > 0) {
            const latestMsg = list[0];
            this.newestMsgId = latestMsg.id;
            const rList = list.reverse();
            const oldestMsg = rList[0];
            this.oldestMsgId = oldestMsg.id;
            this.topMessageList.set(rList)
            this.mergeSentMessages(list)
          }
          if (list.length < TAKE_NUM) {
            this.hasMoreOldMsg.set(false)
          }
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
      return 'msg-self'
    } else {
      return 'msg-friend'
    }
  }

  initThreadInfo() {
    const getThreadInfo = this.msgService.getThreadInfo({
      threadId: parseInt(this.id)
    })
    const getMyInfo = this.msgService.getMyProfile()
    forkJoin([getThreadInfo, getMyInfo]).pipe(mergeMap(([thread, profile]) => {
      this.msgThread = thread
      this.profile = profile
      const { userId1, userId2 } = thread.threadItem.info
      const friendId = userId1 === profile.id ? userId2 : userId1
      return this.msgService.queryFriendInfo({ userId: friendId })
    }))
      .subscribe(res => {
        this.friendProfile = res.friendUser
        this.isReady.set(true)
      })
  }

  ngAfterViewInit() {
    this.inputObserver = new ResizeObserver(entries => {
      const height = entries[0].contentRect.width;
    })
    this.inputObserver.observe((this.userInput() as any).nativeElement);
    this.scrollObserver = new MutationObserver(entries => {
    })
    this.scrollObserver.observe((this.msgScroller() as any).nativeElement, { childList: true });
  }

  ngOnInit() {
    this.initThreadInfo()
    this.initMsgLog()
    this.subOldMessages = this.queryOldMessages
      .pipe(
        filter(() => !this.isLoadingOld()),
        tap(() => this.isLoadingOld.set(true)),
        switchMap((params) => this.msgService.queryMessageLog(params).pipe(
          timeout(2500),
          finalize(() => this.isLoadingOld.set(false)),
          catchError((error) => {
            console.log(error)
            return of([])
          }))
        ),
        filter(list => list.length > 0))
      .subscribe(list => {
        console.log(list, 22)
        const rList = list.reverse();
        const latestMsg = rList[0];
        this.oldestMsgId = latestMsg.id;
        this.topMessageList.set(rList.concat(this.topMessageList()))
        if (list.length < TAKE_NUM) {
          this.hasMoreOldMsg.set(false)
        }
      })
    this.subNewMessages = this.queryNewMessages
      .pipe(
        filter(() => !this.isLoadingNew),
        tap(() => this.isLoadingNew.set(true)),
        switchMap((params) => this.msgService.queryMessageLog(params).pipe(
          timeout(2500),
          finalize(() => this.isLoadingNew.set(false)),
          catchError((error) => {
            console.log(error)
            return of([])
          }))
        ),
        filter((list) => list.length > 0))
      .subscribe({
        next: list => {
          this.newestMsgId = list[list.length - 1].id
          this.messageList.set(this.messageList().concat(list))
          if (list.length < TAKE_NUM) {
            this.hasMoreNewMsg = false
          } else {
            this.hasMoreNewMsg = true
          }
          this.isLoadingNew.set(false)
          if (this.isBottom) {
            setTimeout(() => this.scrollToBottom(), WAIT_FOR_RENDER_INTERVAL)
          }
        }
      })
  }

  ngOnDestroy() {
    this.subNewMessages.unsubscribe();
    this.subOldMessages.unsubscribe();
    this.inputObserver.disconnect()
    this.scrollObserver.disconnect()
  }

  onMsgScroll(event: Event) {
    // const elm = event.target as HTMLDivElement;
    const elm = (this.msgScroller() as any).nativeElement
    const { scrollHeight, scrollTop, clientHeight } = elm
    if (scrollTop < 1000) {
      console.log(2)
      elm.scrollTo(0, 1000)
    } else if (scrollTop < (LOAD_MORE_TRIGGER_OFFSET + 1000) && this.hasMoreOldMsg()) {
      console.log(1)
      this.loadMoreOldMsg()
    } else if (scrollTop > scrollHeight - LOAD_MORE_TRIGGER_OFFSET && this.hasMoreNewMsg) {
      this.loadMoreNewMsg()
    }
    if ((clientHeight + scrollTop) >= scrollHeight) {
      this.isBottom = true;
    } else {
      this.isBottom = false;
    }
  }

  scrollToBottom() {
    const elm = (this.msgScroller() as any).nativeElement
    console.log(elm)
    elm.scrollTo(0, elm.scrollHeight);
  }

}
