import {
  Component, ElementRef, ChangeDetectorRef,
  signal, viewChild, input
} from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MsgService } from '../../../common/services/message.service'
import { WebsocketService } from '../../../common/services/websocket.service';
import { Message, MsgThread, QueryMessageLogParams, } from '../../../common/services/Interfaces';
import {
  Subscription, forkJoin, timeout, finalize,
  Subject, filter, mergeMap, tap,
  switchMap, catchError, of
} from "rxjs";
import { SendingMessage, SentMessage, SendingMessageStatus, MsgGroup, MsgGroupStatus } from './modal';
import { arrayToDictIndex, arraySignal, recordSignal } from '../../../../utils'
import { MsgGroupComponent } from './msg-group/msg-group.component'
import { UserProfile } from './msg-group/modal';

const TAKE_NUM = 10;
const GROUP_NUM = TAKE_NUM;
const LOAD_MORE_TRIGGER_OFFSET = 100;
const UNREAD_INITIAL_PADDING_TOP = 100;
const SCROLL_HEIGHT_THRESHOLD = 1000;

@Component({
  selector: 'app-friend-message',
  standalone: true,
  imports: [FormsModule, NgClass, MsgGroupComponent],
  templateUrl: './friend-message.component.html',
  styleUrl: './friend-message.component.scss'
})
export class FriendMessageComponent {

  threadId = input<string>();
  startMsgId = input<string>();

  readonly userInput = viewChild<ElementRef<HTMLInputElement>>('userInput');
  readonly msgScroller = viewChild<ElementRef<HTMLDivElement>>('msgScroller');
  readonly groupPadding = viewChild<ElementRef<HTMLDivElement>>('groupPadding');

  readonly sendingCnt = signal(0)
  readonly sentMessageList = arraySignal<SentMessage>([])
  readonly failedMessageList = arraySignal<SendingMessage>([])
  readonly isReady = signal(false)
  readonly hasMoreNewMsg = signal(false)
  readonly hasMoreOldMsg = signal(true)
  readonly isLoadingNew = signal(false)
  readonly isLoadingOld = signal(false)
  readonly groupList = arraySignal<MsgGroup>([])
  readonly profileRecord = recordSignal<UserProfile>({})
  readonly groupStatusArray = arraySignal<{ status: MsgGroupStatus, height: number }>([])

  private msgThread: MsgThread | Record<string, undefined> = {}
  private queryOldMessages = new Subject<QueryMessageLogParams>()
  private subOldMessages!: Subscription;
  private queryNewMessages = new Subject<QueryMessageLogParams>()
  private subNewMessages!: Subscription;
  private isBottom = false
  private scrollObserver!: ResizeObserver;
  private messageList: Message[] = [];
  private threshold: { up: number, down: number } | undefined = undefined
  private _threadId!: number
  private _startMsgId: string | undefined
  private _scrollerElm!: HTMLDivElement
  private _oldGrpMsgIdx = 0 //index of messageList point to oldest message in current groups
  private _newGrpMsgIdx = 0
  private _scrollerInfo !: { clientHeight: number, disToBot: number };

  constructor(private msgService: MsgService, private wsService: WebsocketService, private changeDetectorRef: ChangeDetectorRef) {
    this.wsService.eventSubject.subscribe({
      next: (msg) => { console.info('on message', msg) }
    })
  }

  ngOnInit() {
    this._threadId = parseInt(this.threadId() as string)
    this._startMsgId = this.startMsgId()
    this.initThreadInfo()
    this.subOldMessages = this.queryOldMessages
      .pipe(
        filter(() => !this.isLoadingOld()),
        tap(() => this.isLoadingOld.set(true)),
        switchMap((params) => this.msgService.queryMessageLog(params).pipe(
          timeout(2500),
          finalize(() => this.isLoadingOld.set(false)),
          catchError((error) => {
            console.info(error)
            return of(null)
          }))
        ))
      .subscribe(list => {
        if (list === null) {
          return
        }
        const rList = list.reverse();
        this.messageList = rList.concat(this.messageList)
        const index = rList.length
        this._oldGrpMsgIdx += index
        this._newGrpMsgIdx += index
        if (list.length < TAKE_NUM) {
          console.info('no more old message to load, set hasMoreOldMsg false')
          this.hasMoreOldMsg.set(false)
        }
        console.info('checkAndBuildGroup after load new messages')
        this.checkAndBuildGroup()
      })
    this.subNewMessages = this.queryNewMessages
      .pipe(
        filter(() => !this.isLoadingNew()),
        tap(() => this.isLoadingNew.set(true)),
        switchMap((params) => this.msgService.queryMessageLog(params).pipe(
          timeout(2500),
          finalize(() => this.isLoadingNew.set(false)),
          catchError((error) => {
            console.info(error)
            return of(null)
          }))
        ))
      .subscribe({
        next: (list: Message[] | null) => {
          if (!list) {
            return
          }
          this.messageList = this.messageList.concat(list)
          if (list.length < TAKE_NUM) {
            console.info('no more new message to load, set hasMoreNewMsg false')
            this.hasMoreNewMsg.set(false)
          }
          this.isLoadingNew.set(false)
          this.checkAndBuildGroup()
        }
      })
    if (this._startMsgId) {
      console.info('set show specific id scroll group threshold')
      this.threshold = {
        up: SCROLL_HEIGHT_THRESHOLD,
        down: SCROLL_HEIGHT_THRESHOLD - UNREAD_INITIAL_PADDING_TOP,
      }
    } else {
      console.info('set show old group scroll group threshold')
      this.threshold = {
        up: SCROLL_HEIGHT_THRESHOLD,
        down: 0,
      }
    }
    this.checkAndBuildGroup()
  }

  ngAfterViewInit() {
    const elm = (this.msgScroller() as any).nativeElement as HTMLDivElement;
    this._scrollerElm = elm;
    this.scrollObserver = new ResizeObserver(entries => {
      const { clientHeight, scrollTop, scrollHeight } = elm
      console.log('scroller height change, sync with it')
      const { clientHeight: lastClientHeight, disToBot } = this._scrollerInfo
      const delta = lastClientHeight - clientHeight
      console.log(this.isBottom, delta, disToBot)
      if ((this.isBottom && delta > 0) || (!this.isBottom && delta < disToBot)) {
        elm.scrollTop += delta
      }
      this._scrollerInfo = {
        clientHeight,
        disToBot: scrollHeight - (clientHeight + scrollTop)
      }
    })
    const { clientHeight, scrollTop, scrollHeight } = elm
    this._scrollerInfo = {
      clientHeight,
      disToBot: scrollHeight - (clientHeight + scrollTop)
    }
    this.scrollObserver.observe(elm);
  }

  ngOnDestroy() {
    this.subNewMessages.unsubscribe();
    this.subOldMessages.unsubscribe();
    this.scrollObserver.disconnect()
  }

  send() {
    const content = this.getInputText()
    console.info(`send content: ${content}`)
    if (content) {
      return this.msgService.sendMessage({ threadId: this._threadId, content }).pipe(
        tap(() => {
          this.clearTextInput()
          this.sendingCnt.set(this.sendingCnt() + 1)
        }))
        .subscribe(
          {
            next: (res) => {
              this.afterMsgSent()
            },
            error: (error) => {
              console.error(error)
            }
          })
    } else {
      return false
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

  _generateOldGroup(endIndex: number) {
    console.info(`_generateOldGroup(${endIndex})`)
    let startIndex = endIndex - GROUP_NUM, takeNum = GROUP_NUM;
    if (startIndex < 0) {
      takeNum += startIndex;
      startIndex = 0;
    }
    if (takeNum < 1) {
      console.info('no more old message to take, try load')
      this.loadMoreOldMsg()
      return false
    }
    const topList = this.messageList.slice(startIndex, startIndex + takeNum)
    if (topList.length > 0) {
      this._oldGrpMsgIdx = startIndex - 1
      this.groupStatusArray.unshift({ status: MsgGroupStatus.CALCING, height: 0 })
      this.groupList.set([{
        id: topList[0].id,
        list: topList
      }].concat(this.groupList()))
      return true
    } else {
      console.info('no more old message to take, return')
      return false
    }
  }

  _generateNewGroup(startIndex: number) {
    console.info(`_generateNewGroup(${startIndex})`)
    const botList = this.messageList.slice(startIndex, startIndex + GROUP_NUM)
    if (botList.length > 0) {
      this._newGrpMsgIdx = startIndex + botList.length
      this.groupStatusArray.push({ status: MsgGroupStatus.CALCING, height: 0 })
      this.groupList.push({
        id: botList[0].id,
        list: botList
      })
      return true
    } else {
      console.info('no more new message to take, try load')
      this.loadMoreNewMsg()
      return false
    }
  }

  tryGenerateGroup(derection: 0 | 1): boolean {
    console.info(`tryGenerateGroup(${derection})`)
    const groupStatusArray = this.groupStatusArray();
    if (groupStatusArray.length === 0) {
      let startId = this._startMsgId
      if (startId) {
        const index = this.messageList.findIndex(msg => msg.id === this._startMsgId)
        this._generateNewGroup(index)
        this._generateOldGroup(index - 1)
        return true
      } else {
        return this._generateOldGroup(this._oldGrpMsgIdx)
      }
    } else if (derection === 0) {
      return this._generateOldGroup(this._oldGrpMsgIdx)
    } else {
      return this._generateNewGroup(this._newGrpMsgIdx)
    }
  }

  loadMoreOldMsg() {
    console.info('loadMoreOldMsg')
    if (!this.hasMoreOldMsg()) {
      console.info('has no more old message, shold not load.')
      return
    }
    const startId = this._startMsgId, oldestMsg = this.messageList[0]
    if (oldestMsg) {
      console.info('delta query more old data')
      this.queryOldMessages.next({
        threadId: this._threadId, take: TAKE_NUM, skip: 1,
        lastId: oldestMsg.id, orderBy: 'desc'
      })
    }
    else {
      if (startId) {
        console.info('first query old group with startId')
        this.queryOldMessages.next({
          threadId: this._threadId, take: TAKE_NUM, skip: 1,
          lastId: startId, orderBy: 'desc'
        })
      } else {
        console.info('first query old group')
        this.queryOldMessages.next({
          threadId: this._threadId, take: TAKE_NUM, skip: 0,
          orderBy: 'desc'
        })
      }
    }
  }

  loadMoreNewMsg() {
    console.info('loadMoreNewMsg')
    if (!this.hasMoreNewMsg()) {
      console.info('has no more new message, shold not load.')
      return
    }
    const startId = this._startMsgId, messageList = this.messageList
    const newestMsg = messageList[messageList.length - 1]
    if (newestMsg) {
      console.info('delta query more new data')
      this.queryNewMessages.next({
        threadId: this._threadId,
        orderBy: 'asc',
        take: TAKE_NUM,
        skip: 1,
        lastId: newestMsg.id
      })
    } else {
      if (startId) {
        console.info('first query new group with startId')
        this.queryNewMessages.next({
          threadId: this._threadId,
          orderBy: 'asc',
          take: TAKE_NUM,
          skip: 0,
          lastId: startId
        })
      } else {
        console.error('can not query new message without startId')
      }
    }
  }


  initThreadInfo() {
    const getThreadInfo = this.msgService.getThreadInfo({
      threadId: this._threadId
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

  checkAndBuildGroup() {
    const statusList = this.groupStatusArray()
    let newScrollHeight = 0, upsideGroupHeight = 0,
      downsideGroupHeight = 0, isUpsideHeightEnd = false,
      isDownsideHeightBegin = false, isAllStable = true
    for (let i = 0; i < statusList.length; i++) {
      const item = statusList[i]
      if (item.status === MsgGroupStatus.CALCING) {
        console.info('still calculating group, waiting for it')
        return
      } else if (item.status === MsgGroupStatus.STABLE) {
        isUpsideHeightEnd = true
      } else if (item.status === MsgGroupStatus.PREPARED) {
        isAllStable = false
        if (isUpsideHeightEnd) {
          isDownsideHeightBegin = true
        }
      }
      if (!isUpsideHeightEnd) {
        upsideGroupHeight += item.height
      } else if (isDownsideHeightBegin) {
        downsideGroupHeight += item.height
      }
      newScrollHeight += item.height
    }
    //initial upside and downside height
    if (this.threshold !== undefined) {
      upsideGroupHeight = newScrollHeight
      downsideGroupHeight = 0
    }
    if (isAllStable) {
      console.info("all groups are stable, check to load more groups")
      if (this.threshold === undefined) {
        console.info("delta generating groups")
        const { scrollTop, clientHeight, scrollHeight } = this._scrollerElm
        if (scrollTop < (LOAD_MORE_TRIGGER_OFFSET)) {
          console.info('scroll reached top, try load more old group')
          this.tryGenerateGroup(0)
        } else if (scrollTop + clientHeight > scrollHeight - LOAD_MORE_TRIGGER_OFFSET) {
          console.info('scroll reached bottom, try load more new group')
          this.tryGenerateGroup(1)
        }
        return
      } else {
        console.info("initial generating groups")
        const up = this.threshold.up, hasMoreOldMsg = this.hasMoreOldMsg(), hasMoreNewMsg = this.hasMoreNewMsg()
        if (upsideGroupHeight < up) {
          if (hasMoreOldMsg || (!hasMoreOldMsg && this._oldGrpMsgIdx > 0)) {
            console.info('upside group not satisfied threshold, try add group')
            this.tryGenerateGroup(0)
            return
          }
        }
        if (downsideGroupHeight < this.threshold.down) {
          if (hasMoreNewMsg || (!hasMoreNewMsg && this._newGrpMsgIdx < this.messageList.length)) {
            console.info('downside group not satisfied threshold, try add group')
            this.tryGenerateGroup(1)
            return
          }
        }
      }
    }

    //calc height and scrollTop 
    console.info('upside and downside are both ready, show it!')
    const { scrollTop, clientHeight } = this._scrollerElm
    const elm = (this.groupPadding() as any).nativeElement
    elm.style.height = newScrollHeight + 'px';
    if (this.threshold === undefined) {
      console.info('delta setting scrollHeight')
      if (newScrollHeight > clientHeight) {
        if (this.isBottom) {
          if (downsideGroupHeight < clientHeight) {
            this._scrollerElm.scrollTop = newScrollHeight - clientHeight;
          } else {
            let scrollTop = newScrollHeight - downsideGroupHeight - UNREAD_INITIAL_PADDING_TOP
            if (scrollTop < 0) {
              scrollTop = 0
            }
            this._scrollerElm.scrollTop = scrollTop
          }
        } else {
          this._scrollerElm.scrollTop = scrollTop + upsideGroupHeight
        }
      } else {
        this._scrollerElm.scrollTop = 0
        this.isBottom = true
      }
    } else {
      console.info('initial setting scrollHeight')
      if (this._startMsgId) {
        if (newScrollHeight > clientHeight) {
          const newScrollTop = newScrollHeight - downsideGroupHeight - UNREAD_INITIAL_PADDING_TOP
          if (newScrollTop > 0) {
            this._scrollerElm.scrollTop = newScrollTop;
          } else {
            this._scrollerElm.scrollTop = 0
          }
        } else {
          this._scrollerElm.scrollTop = 0
          this.isBottom = true
        }
      } else {
        const newScrollTop = newScrollHeight - downsideGroupHeight
        if (newScrollTop > 0) {
          this._scrollerElm.scrollTop = newScrollTop;
        } else {
          this._scrollerElm.scrollTop = 0
        }
        this.isBottom = true
      }
      this.threshold = undefined
    }
    this.groupStatusArray.set(statusList.map(item => {
      if (item.status !== MsgGroupStatus.PREPARED) {
        return item
      } else {
        return { status: MsgGroupStatus.STABLE, height: item.height }
      }
    }
    ))
  }

  onMsgScroll(event: Event) {
    console.info('onMsgScroll')
    const { scrollTop, scrollHeight, clientHeight } = this._scrollerElm
    if ((clientHeight + scrollTop) >= scrollHeight - 1) {
      this.isBottom = true;
    } else {
      this.isBottom = false;
    }
    this._scrollerInfo = {
      clientHeight,
      disToBot: scrollHeight - (clientHeight + scrollTop)
    }
    if (scrollTop < (LOAD_MORE_TRIGGER_OFFSET)) {
      console.info('scroll reached top, try load more old group')
      this.tryGenerateGroup(0)
    } else if (scrollTop > scrollHeight - LOAD_MORE_TRIGGER_OFFSET) {
      console.info('scroll reached bottom, try load more new group')
      this.tryGenerateGroup(1)
    };
    this.checkAndBuildGroup()
  }

  scrollToBottom() {
    const elm = this._scrollerElm
    elm.scrollTo(0, elm.scrollHeight);
  }

  onGroupComStatusChange({ index, status, height }: { index: number, status: MsgGroupStatus, height: number }) {
    if (status === MsgGroupStatus.PREPARED) {
      console.info(`new group[${index}] prepared, start checkAndBuildGroup`)
      const array = this.groupStatusArray()
      const newItem = {
        status: status,
        height: height
      }
      const newArr = array.slice(0, index).concat(newItem).concat(array.slice(index + 1))
      this.groupStatusArray.set(newArr)
      this.checkAndBuildGroup()
    }
  }

  onUserInput(event: Event) {
    console.log((event as InputEvent).data)
  }

  getInputText() {
    const elm = (this.userInput() as any).nativeElement as HTMLDivElement
    return elm.textContent;
  }

  clearTextInput() {
    const elm = (this.userInput() as any).nativeElement as HTMLDivElement
    elm.innerHTML = ''
  }

  afterMsgSent() {
    this.hasMoreNewMsg.set(true)
    if (this.isBottom) {
      this.checkAndBuildGroup()
    } else {

    }
  }
}
