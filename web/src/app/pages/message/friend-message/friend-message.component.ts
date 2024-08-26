import { Component, ElementRef, model, signal, viewChild, Input, computed, effect } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MsgService } from '../../../common/services/message.service'
import { WebsocketService } from '../../../common/services/websocket.service';
import { Input as RouterInput } from '@angular/core'
import { Message, MsgThread, QueryMessageLogParams, } from '../../../common/services/Interfaces';
import {
  Subscription, forkJoin, timeout, finalize,
  Subject, filter, mergeMap, tap, switchMap, catchError, of
} from "rxjs";
import { SendingMessage, SentMessage, SendingMessageStatus, MsgGroup, MsgGroupInfo, MsgGroupStatus } from './modal';
import { arrayToDictIndex, arraySignal, recordSignal } from '../../../../utils'
import { MsgGroupComponent } from './msg-group/msg-group.component'
import { UserProfile } from './msg-group/modal';

const TAKE_NUM = 10;
const GROUP_NUM = 10;
const WAIT_FOR_RENDER_INTERVAL = 100;
const LOAD_MORE_TRIGGER_OFFSET = 100;
const MaxScrollHeight = 1000;


interface PositionInfo {
  scrollHeight: number, scrollTop: number, clientHeight: number
}

@Component({
  selector: 'app-friend-message',
  standalone: true,
  imports: [FormsModule, NgClass, MsgGroupComponent],
  templateUrl: './friend-message.component.html',
  styleUrl: './friend-message.component.scss'
})
export class FriendMessageComponent {

  @RouterInput() id!: string;
  @RouterInput() startId!: string;

  readonly userInput = viewChild<ElementRef<HTMLInputElement>>('userInput');
  readonly msgScroller = viewChild<ElementRef<HTMLDivElement>>('msgScroller');

  readonly inputText = model('inputText');
  readonly sendingMessageList = arraySignal<SendingMessage>([])
  readonly sentMessageList = arraySignal<SentMessage>([])
  readonly failedMessageList = arraySignal<SendingMessage>([])
  readonly isReady = signal(false)
  readonly hasMoreNewMsg = signal(false)
  readonly hasMoreOldMsg = signal(true)
  readonly hasMoreNewDispMsg = signal(true)
  readonly hasMoreOldDispMsg = signal(true)
  readonly isLoadingNew = signal(false)
  readonly isLoadingOld = signal(false)
  readonly positionInfo = signal<PositionInfo>({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 })
  readonly groupList = arraySignal<MsgGroup>([])
  readonly profileRecord = recordSignal<UserProfile>({})

  private msgThread: MsgThread | Record<string, undefined> = {}
  private queryOldMessages = new Subject<QueryMessageLogParams>()
  private subOldMessages!: Subscription;
  private queryNewMessages = new Subject<QueryMessageLogParams>()
  private subNewMessages!: Subscription;
  private newestMsgId: string | undefined = undefined
  private oldestMsgId: string | undefined = undefined
  private isBottom = true
  private sentTempId = 0;
  private inputObserver!: ResizeObserver;
  private scrollObserver!: MutationObserver;
  private groupInfoArray: MsgGroupInfo[] = []
  private messageList: Message[] = [];

  constructor(private msgService: MsgService, private wsService: WebsocketService) {
    effect(() => {
      const msgs = this.messageList;
      if (msgs.length > 0) {
        this.oldestMsgId = msgs[0].id; this.newestMsgId = msgs[msgs.length - 1].id
      }
    })
    this.wsService.eventSubject.subscribe({
      next: (msg) => { console.log('on message', msg) }
    })
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
        this.messageList = rList.concat(this.messageList)
        if (list.length < TAKE_NUM) {
          this.hasMoreOldMsg.set(false)
        }
        this.checkAndBuildGroup()
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
          this.messageList = this.messageList.concat(list)
          if (list.length < TAKE_NUM) {
            this.hasMoreNewMsg.set(false)
          } else {
            this.hasMoreNewMsg.set(true)
          }
          this.isLoadingNew.set(false)
          this.checkAndBuildGroup()
        }
      })
  }

  ngOnInit() {
    this.initThreadInfo()
    this.initMsgLog()
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
              this.hasMoreNewMsg.set(true)
              this.showMoreNewMsg()
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

  _generateOlderGroup(endIndex: number) {
    let startIndex = endIndex - GROUP_NUM, takeNum = GROUP_NUM;
    if (startIndex < 0) {
      takeNum += startIndex;
      startIndex = 0;
    }
    if (takeNum < 0) {
      if (!this.hasMoreOldMsg()) {
        this.hasMoreOldDispMsg.set(false)
      }
      return false
    }
    const topList = this.messageList.slice(startIndex, takeNum)
    if (topList.length > 0) {
      this.groupInfoArray = this.groupInfoArray.concat({
        id: topList[0].id,
        startIndex: startIndex,
        endIndex: startIndex + takeNum,
        status: MsgGroupStatus.CALCING
      })
      this.groupList.set(this.groupList().concat({
        id: topList[0].id,
        list: topList
      }))
      if (topList.length <= GROUP_NUM && !this.hasMoreOldMsg()) {
        this.hasMoreOldDispMsg.set(false)
      }
    }
    return false
  }

  _generateNewerGroup(startIndex: number) {
    const botList = this.messageList.slice(startIndex, GROUP_NUM)
    if (botList.length > 0) {
      this.groupInfoArray.push({
        id: botList[0].id,
        startIndex: startIndex,
        endIndex: startIndex + botList.length,
        status: MsgGroupStatus.CALCING
      })
      this.groupList.push({
        id: botList[0].id,
        list: botList
      })
      if (botList.length <= GROUP_NUM && !this.hasMoreNewMsg()) {
        this.hasMoreNewDispMsg.set(false)
      }
      return true
    } else {
      if (!this.hasMoreNewMsg()) {
        this.hasMoreNewDispMsg.set(false)
      }
      return false
    }
  }

  tryGenerateGroup(derection: 0 | 1): boolean {
    const groupInfolist = this.groupInfoArray;
    if (groupInfolist.length === 0) {
      let startId = this.startId
      const msgList = this.messageList;
      if (startId) {
        const index = this.messageList.findIndex(msg => msg.id === this.startId)
        this._generateNewerGroup(index)
        this._generateOlderGroup(index - 1)
        return true
      } else {
        return this._generateOlderGroup(msgList.length - 1)
      }
    } else if (derection === 0) {
      const topIndex = groupInfolist[0].startIndex
      return this._generateOlderGroup(topIndex - 1)
    } else {
      const botIndex = groupInfolist[groupInfolist.length - 1].endIndex
      return this._generateNewerGroup(botIndex + 1)
    }
  }

  showMoreOldMsg() {
    if (!this.hasMoreOldDispMsg()) {
      return
    }
    if (!this.tryGenerateGroup(0)) {
      this.queryOldMessages.next({
        threadId: parseInt(this.id), take: TAKE_NUM, skip: 1,
        lastId: this.oldestMsgId, orderBy: 'desc'
      })
    }
  }

  showMoreNewMsg() {
    if (!this.hasMoreNewDispMsg()) {
      return
    }
    if (!this.tryGenerateGroup(1)) {
      this.queryNewMessages.next({
        threadId: parseInt(this.id),
        orderBy: 'asc' as 'asc',
        take: TAKE_NUM,
        skip: 1,
        lastId: this.newestMsgId
      })
    }
  }

  initMsgLog() {
    if (this.startId) {
      this.queryOldMessages.next({
        threadId: parseInt(this.id), orderBy: 'desc',
        take: TAKE_NUM, skip: 1
      })
      this.queryNewMessages.next({
        threadId: parseInt(this.startId), orderBy: 'asc',
        take: TAKE_NUM, skip: 0
      })
    } else {
      this.queryOldMessages.next({
        threadId: parseInt(this.id), orderBy: 'desc',
        take: TAKE_NUM, skip: 0
      })
    }
  }

  initThreadInfo() {
    const getThreadInfo = this.msgService.getThreadInfo({
      threadId: parseInt(this.id)
    })
    const getMyInfo = this.msgService.getMyProfile()
    forkJoin([getThreadInfo, getMyInfo]).pipe(mergeMap(([thread, profile]) => {
      this.msgThread = thread
      this.profileRecord.set(profile.id, { id: profile.id, uniqName: profile.uniqName, isSelf: true })
      const { userId1, userId2 } = thread.threadItem.info
      const friendId = userId1 === profile.id ? userId2 : userId1
      return this.msgService.queryFriendInfo({ userId: friendId })
    }))
      .subscribe(res => {
        const friendProfile = res.friendUser
        this.profileRecord.set(friendProfile.id, { id: friendProfile.id, uniqName: friendProfile.uniqName, isSelf: false })
        this.isReady.set(true)
      })
  }

  ngOnDestroy() {
    this.subNewMessages.unsubscribe();
    this.subOldMessages.unsubscribe();
    this.inputObserver.disconnect()
    this.scrollObserver.disconnect()
  }

  checkAndBuildGroup() {
    const { scrollTop, scrollHeight, clientHeight } = this.positionInfo()
    if (clientHeight >= scrollHeight) {
      this.tryGenerateGroup(1)
    } else if (scrollTop < (LOAD_MORE_TRIGGER_OFFSET) && this.hasMoreOldDispMsg()) {
      this.tryGenerateGroup(0)
    } else if (scrollTop > scrollHeight - LOAD_MORE_TRIGGER_OFFSET && this.hasMoreNewDispMsg()) {
      this.tryGenerateGroup(1)
    } else {

    }
  }

  onMsgScroll(event: Event) {
    // const elm = event.target as HTMLDivElement;
    const elm = (this.msgScroller() as any).nativeElement
    const { scrollHeight, scrollTop, clientHeight } = elm
    this.positionInfo.set({ scrollTop, clientHeight, scrollHeight })
    this.checkAndBuildGroup()
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
  onGroupComStatusChange(event: { height: number }) {
    // let info = this.groupInfoArray[index]
  }
}
