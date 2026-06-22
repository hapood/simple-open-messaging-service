import {
  Component, ElementRef, signal, viewChild, input, Signal,

} from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WebsocketService } from '../../services/websocket.service';
import { MsgGroupStatus, DisMsgGrp } from './model';
import { MsgGroupComponent } from '../message/msg-group/msg-group.component'
import { MessageHeaderComponent } from '../message-header/message-header.component';
import { MsgInputBarComponent } from '../message/msg-input-bar/msg-input-bar.component';
import { MsgGroupFactory } from './MsgGroupFactory';
import { MsgService } from '../../services/message.service'
import { UserService } from '../../services/user.service';
import { UserMessageThread } from '../../services/model';

const LOAD_MORE_TRIGGER_OFFSET = 100;
const UNREAD_INITIAL_PADDING_TOP = 100;
const SCROLL_HEIGHT_THRESHOLD = 1000;

@Component({
    selector: 'app-message-thread',
    imports: [FormsModule, NgClass, MsgGroupComponent, MessageHeaderComponent, MsgInputBarComponent],
    templateUrl: './friend-message.component.html',
    styleUrl: './friend-message.component.scss'
})
export class MessageThreadComponent {

  userThreadId = input<number>();
  startMsgId = input<string>();

  grpStatArrSig: Signal<MsgGroupStatus[]> | undefined
  dispGrpList: Signal<DisMsgGrp[]> | undefined

  readonly msgScroller = viewChild<ElementRef<HTMLDivElement>>('msgScroller');
  readonly groupPadding = viewChild<ElementRef<HTMLDivElement>>('groupPadding');

  readonly userMsgTrd = input<UserMessageThread>()

  private isBottom = false
  private scrollObserver!: ResizeObserver;
  private threshold: { up: number, down: number } | undefined = undefined
  private _startMsgId: string | undefined
  private _scrollerElm!: HTMLDivElement
  private _scrollerInfo!: { clientHeight: number, disToBot: number };
  private grpFactory!: MsgGroupFactory

  constructor(private wsService: WebsocketService, private msgService: MsgService,
    private userService: UserService) {
    this.wsService.eventSubject.subscribe({
      next: (msg) => {
        if (msg.event === 'NEW_MESSAGE' && msg.status === 0) {
          const msgData = msg.data
          if (msgData.threadId === this.grpFactory.userMsgTrd.threadId) {
            this.grpFactory.newMessageNotify(msgData.msgId)
            this.checkAndBuildGroup()
          }
        }
      }
    })
  }

  ngOnInit() {
    const userThreadId = this.userThreadId()!, startMsgId = this.startMsgId()
    this.initialize(userThreadId, startMsgId)
  }

  initialize(userThreadId: number, startMsgId: string | undefined) {
    this._startMsgId = startMsgId
    if (startMsgId) {
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
    const grpFactory = new MsgGroupFactory({
      cb: {
        beforeGrpRemoved: () => { },
        afterMsgListAdd: (direction) => {
          this.checkAndBuildGroup()
        },
        afterGrpReady: () => {
          this.checkAndBuildGroup()
        },
        onMsgThreadInit: () => {
          this.checkAndBuildGroup()
        }
      }
      , startMsgId,
      userThreadId,
      msgService: this.msgService,
      userService: this.userService,
      userMsgTrd: this.userMsgTrd()!
    })
    this.grpStatArrSig = grpFactory.grpStatArrSig
    this.dispGrpList = grpFactory.dispGrpList
    this.grpFactory = grpFactory
  }

  ngAfterViewInit() {
    const elm = this.msgScroller()!.nativeElement;
    this._scrollerElm = elm;
    this.scrollObserver = new ResizeObserver(entries => {
      const { clientHeight, scrollTop, scrollHeight } = elm
      console.info('scroller height change, sync with it')
      const { clientHeight: lastClientHeight, disToBot } = this._scrollerInfo
      const delta = lastClientHeight - clientHeight
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
    this.checkAndBuildGroup()
  }

  ngOnDestroy() {
    this.scrollObserver.disconnect()
  }

  onAfterSent() {
    this.afterMsgSent()
  }

  checkAndBuildGroup() {
    let result = this.grpFactory.calcPreparedHeight()
    if (!result) {
      //wait for calculating
      return
    }
    let { newScrollHeight, upsideGroupHeight, downsideGroupHeight, isAllStable } = result
    if (this.threshold !== undefined) {
      //initial upside and downside height
      upsideGroupHeight = newScrollHeight
      downsideGroupHeight = 0
    }
    const grpFactory = this.grpFactory
    if (isAllStable) {
      console.info("all groups are stable, check to load more groups")
      if (this.threshold === undefined) {
        const { scrollTop, clientHeight, scrollHeight } = this._scrollerElm
        if (scrollTop < (LOAD_MORE_TRIGGER_OFFSET)) {
          console.info('scroll reached top, try load more old group')
          grpFactory.startBuild(0)
        }
        if (scrollTop + clientHeight > scrollHeight - LOAD_MORE_TRIGGER_OFFSET) {
          console.info('scroll reached bottom, try load more new group')
          grpFactory.startBuild(1)
        }
        console.info("no need for delta generating")
        return
      } else {
        const up = this.threshold.up
        if (upsideGroupHeight < up) {
          console.info('upside group not satisfied threshold, try add group')
          grpFactory.startBuild(0)
        }
        if (downsideGroupHeight < this.threshold.down) {
          console.info('downside group not satisfied threshold, try add group')
          grpFactory.startBuild(1)
        }
        console.info("initial generating finished")
      }
    }

    //calc height and scrollTop 
    console.info('upside and downside are both ready, show it!')
    const { scrollTop, clientHeight } = this._scrollerElm
    const elm = this.groupPadding()!.nativeElement
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
          elm.style.display = "flex"
          elm.style.flexDirection = "column"
          elm.style.justifyContent = "flex-end"
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
        const newScrollTop = newScrollHeight - downsideGroupHeight - clientHeight
        if (newScrollTop > 0) {
          this._scrollerElm.scrollTop = newScrollTop
        } else {
          this._scrollerElm.scrollTop = 0
        }
        this.isBottom = true
      }
      this.threshold = undefined
    }
    grpFactory.preparedToStable()
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
    this.checkAndBuildGroup()
  }

  scrollToBottom() {
    const elm = this._scrollerElm
    elm.scrollTo(0, elm.scrollHeight);
  }

  onGroupHeightChange(params: { index: number, height: number }) {
    this.grpFactory.updateGrpheight(params)
    this.checkAndBuildGroup()
  }

  afterMsgSent() {
  }
}
