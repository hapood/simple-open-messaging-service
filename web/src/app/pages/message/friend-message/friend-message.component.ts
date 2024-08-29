import {
  Component, ElementRef, model,
  signal, viewChild, effect
} from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MsgService } from '../../../common/services/message.service'
import { WebsocketService } from '../../../common/services/websocket.service';
import { Input as RouterInput } from '@angular/core'
import { Message, MsgThread, QueryMessageLogParams, } from '../../../common/services/Interfaces';
import {
  Subscription, forkJoin, timeout, finalize,
  Subject, filter, mergeMap, tap,
  switchMap, catchError, of
} from "rxjs";
import { SendingMessage, SentMessage, SendingMessageStatus, MsgGroup, MsgGroupInfo, MsgGroupStatus } from './modal';
import { arrayToDictIndex, arraySignal, recordSignal } from '../../../../utils'
import { MsgGroupComponent } from './msg-group/msg-group.component'
import { UserProfile } from './msg-group/modal';

const TAKE_NUM = 10;
const GROUP_NUM = 10;
const WAIT_FOR_RENDER_INTERVAL = 100;
const LOAD_MORE_TRIGGER_OFFSET = 100;
const UNREAD_INITIAL_PADDING_TOP = 100;
const SCROLL_HEIGHT_THRESHOLD = 1000;

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
  readonly isLoadingNew = signal(false)
  readonly isLoadingOld = signal(false)
  readonly positionInfo = signal<PositionInfo>({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 })
  readonly groupList = arraySignal<MsgGroup>([])
  readonly profileRecord = recordSignal<UserProfile>({})
  readonly groupStatusArray = arraySignal<{ status: MsgGroupStatus, height: number }>([])

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
  private scrollObserver!: ResizeObserver;
  private groupInfoArray: MsgGroupInfo[] = []
  private messageList: Message[] = [];
  private nextScrollHeight = 0
  private threshold = { up: 0, down: 0, dGrpId: null }

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
  }

  ngOnInit() {
    this.initThreadInfo()
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
    if (this.id) {
      console.log('set show specific id scroll group threshold')
      this.threshold = {
        up: SCROLL_HEIGHT_THRESHOLD,
        down: SCROLL_HEIGHT_THRESHOLD - UNREAD_INITIAL_PADDING_TOP,
        dGrpId: null
      }
      this.showMoreOldMsg()
      this.showMoreNewMsg()
    } else {
      console.log('set show old group scroll group threshold')
      this.threshold = {
        up: SCROLL_HEIGHT_THRESHOLD,
        down: 0,
        dGrpId: null
      }
      this.showMoreOldMsg()
    }
  }

  ngAfterViewInit() {
    this.inputObserver = new ResizeObserver(entries => {
      const height = entries[0].contentRect.width;
    })
    this.inputObserver.observe((this.userInput() as any).nativeElement);
    const elm = (this.msgScroller() as any).nativeElement as HTMLDivElement;
    const { scrollTop, clientHeight, scrollHeight } = elm
    this.positionInfo.set({ scrollTop, clientHeight, scrollHeight })
    this.scrollObserver = new ResizeObserver(entries => {
      const height = entries[0].contentRect.height;
      const { scrollTop, scrollHeight } = elm
      this.positionInfo.set({ scrollTop, scrollHeight, clientHeight: height })
    })
    this.scrollObserver.observe(elm);
  }

  ngOnDestroy() {
    this.subNewMessages.unsubscribe();
    this.subOldMessages.unsubscribe();
    this.inputObserver.disconnect()
    this.scrollObserver.disconnect()
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
    console.log(`_generateOlderGroup${endIndex}`)
    let startIndex = endIndex - GROUP_NUM, takeNum = GROUP_NUM;
    if (startIndex < 0) {
      takeNum += startIndex;
      startIndex = 0;
    }
    if (takeNum < 0) {
      return false
    }
    const topList = this.messageList.slice(startIndex, takeNum)
    if (topList.length > 0) {
      this.groupInfoArray = this.groupInfoArray.concat({
        id: topList[0].id,
        startIndex: startIndex,
        endIndex: startIndex + takeNum,
      })
      this.groupStatusArray.unshift({ status: MsgGroupStatus.CALCING, height: 0 })
      this.groupList.set(this.groupList().concat({
        id: topList[0].id,
        list: topList
      }))
    }
    return false
  }

  _generateNewerGroup(startIndex: number) {
    console.log(`_generateNewerGroup${startIndex}`)
    const botList = this.messageList.slice(startIndex, GROUP_NUM)
    if (botList.length > 0) {
      this.groupInfoArray.push({
        id: botList[0].id,
        startIndex: startIndex,
        endIndex: startIndex + botList.length,
      })
      this.groupStatusArray.push({ status: MsgGroupStatus.CALCING, height: 0 })
      this.groupList.push({
        id: botList[0].id,
        list: botList
      })
      return true
    } else {
      return false
    }
  }

  tryGenerateGroup(derection: 0 | 1): boolean {
    console.log(`tryGenerateGroup(${derection})`)
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
    console.log('showMoreOldMsg')
    if (!this.tryGenerateGroup(0)) {
      const lastReadId = this.id
      if (this.newestMsgId) {
        console.log('delta query more old data')
        this.queryOldMessages.next({
          threadId: this.newestMsgId, take: TAKE_NUM, skip: 1,
          lastId: this.oldestMsgId, orderBy: 'desc'
        })
      }
      else {
        if (lastReadId) {
          console.log('first query las')
          this.queryOldMessages.next({
            threadId: lastReadId, take: TAKE_NUM, skip: 0,
            lastId: this.oldestMsgId, orderBy: 'desc'
          })
        }
      }
    }
  }

  showMoreNewMsg() {
    console.log('showMoreNewMsg')
    if (!this.tryGenerateGroup(1)) {
      const lastReadId = this.id
      if (this.newestMsgId) {
        this.queryNewMessages.next({
          threadId: this.newestMsgId,
          orderBy: 'asc',
          take: TAKE_NUM,
          skip: 1,
          lastId: this.newestMsgId
        })
      } else {
        if (lastReadId) {
          this.queryNewMessages.next({
            threadId: lastReadId,
            orderBy: 'asc',
            take: TAKE_NUM,
            skip: 0,
            lastId: this.newestMsgId
          })
        }
      }
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

  buildGroupOnScroll() {
    const { scrollTop, scrollHeight } = this.positionInfo()
    if (scrollTop < (LOAD_MORE_TRIGGER_OFFSET)) {
      this.tryGenerateGroup(0)
    } else if (scrollTop > scrollHeight - LOAD_MORE_TRIGGER_OFFSET) {
      this.tryGenerateGroup(1)
    }
  }

  checkAndBuildGroup() {
    const statusList = this.groupStatusArray()
    let isUpsideFinished = true, isDownsideFinished = true, dGrpId = this.threshold.dGrpId
    if (this.threshold.up > 0) {
      if (dGrpId === null || dGrpId < 1) {
        if (this.hasMoreOldMsg()) {
          console.log('waiting for new upside data')
          isUpsideFinished = false
        } else {
          console.log('no upside group exist')
        }
      } else {
        let hStatus = statusList[0]
        if (hStatus.status === MsgGroupStatus.CALCING) {
          isUpsideFinished = false
          console.log('still calculating upside group, waiting for it')
        } else {
          const upsideGroupHeight = statusList.slice(0, dGrpId).reduce((prev, cur) => prev + cur.height, 0)
          if (upsideGroupHeight < this.threshold.up) {
            console.log('try to add upside group')
            isUpsideFinished = false
            this.tryGenerateGroup(0)
          } else {
            console.log('upside group is prepared')
          }
        }
      }
    }
    //downside
    if (dGrpId === null) {
      if (this.hasMoreNewMsg()) {
        console.log('waiting for new upside data')
        isDownsideFinished = false
      } else {
        console.log('no downside group exist')
      }
    } else {
      let tStatus = statusList[statusList.length - 1]
      if (tStatus.status === MsgGroupStatus.CALCING) {
        isDownsideFinished = false
        console.log('still calculating downside group, waiting for it')
      } else {
        const downsideGroupHeight = statusList.slice(dGrpId).reduce((prev, cur) => prev + cur.height, 0)
        if (downsideGroupHeight < this.threshold.down) {
          console.log('try to add downside group')
          isDownsideFinished = false
          this.tryGenerateGroup(1)
        } else {
          console.log('downside group is prepared')
        }
      }
    }
    if (isDownsideFinished && isUpsideFinished) {
      this.groupStatusArray.set(statusList.map(item =>
        ({ status: MsgGroupStatus.STABLE, height: item.height })))
    }
  }

  onMsgScroll(event: Event) {
    // const elm = event.target as HTMLDivElement;
    const elm = (this.msgScroller() as any).nativeElement
    const { scrollHeight, scrollTop, clientHeight } = elm
    this.positionInfo.set({ scrollTop, clientHeight, scrollHeight })
    this.buildGroupOnScroll()
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
