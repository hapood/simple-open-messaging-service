import { signal } from '@angular/core';
import { MsgService } from '../../../common/services/message.service'
import { Message, MsgThread, QueryMessageLogParams, } from '../../../common/services/Interfaces';
import {
  Subscription, forkJoin, timeout, finalize,
  Subject, filter, mergeMap, tap, Observable,
  switchMap, catchError, of, firstValueFrom
} from "rxjs";
import { default as dayjs } from 'dayjs'
import { UserProfile } from './msg-group/modal';
import { MsgGroup, MsgGroupStatus, DisplayMsg } from './modal';

const TAKE_NUM = 10;
const GROUP_NUM = TAKE_NUM;

export interface ThreadInfo {
  title: string
}

export interface GrpAddInfo {
  direction: 0 | 1,
  list: MsgGroup[],
  status: MsgGroupStatus
}

interface MsgFactCallback {
  onMessageLoad: (direction: number) => void
  onThreadInit: (info: ThreadInfo) => void
}

export class MsgGroupFactory {
  private msgService: MsgService;

  readonly groupList = signal<MsgGroup[]>([])
  readonly groupStatusArray = signal<{ status: MsgGroupStatus, height: number }[]>([])

  private msgThread: MsgThread | Record<string, undefined> = {}
  private profileRecord: Record<string, UserProfile> = {}
  private messageList: Message[] = [];
  private queryOldMessages = new Subject<QueryMessageLogParams>()
  private subOldMessages!: Subscription;
  private queryNewMessages = new Subject<QueryMessageLogParams>()
  private subNewMessages!: Subscription;
  private isLoadingOld = false
  private isLoadingNew = false
  //_oldGrpMsgIdx+1 is the index of messageList, whitch point to oldest message
  // in current groups, maybe out of range, means message group is empty
  private _oldGrpMsgIdx = 0
  private _newGrpMsgIdx = 0
  private hasMoreNewMsg = false
  private hasMoreOldMsg = true
  private _startMsgId: string | undefined
  private cb: MsgFactCallback
  private threadIdNum: number
  private initSglUsrPf$!: Observable<any>

  constructor({ cb, startMsgId, threadIdNum, msgService }:
    { cb: MsgFactCallback, startMsgId?: string, threadIdNum: number, msgService: MsgService }) {
    this.cb = cb
    this._startMsgId = startMsgId
    this.threadIdNum = threadIdNum
    this.msgService = msgService
    this.initThreadInfo()

    this.subOldMessages = this.queryOldMessages
      .pipe(
        filter(() => !this.isLoadingOld),
        tap(() => this.isLoadingOld = true),
        switchMap((params) => this.msgService.queryMessageLog(params).pipe(
          timeout(2500),
          finalize(() => this.isLoadingOld = false),
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
          this.hasMoreOldMsg = false
        }
        console.info('onMessageLoad 0')
        this.onMessageLoad(0)
      })
    this.subNewMessages = this.queryNewMessages
      .pipe(
        filter(() => !this.isLoadingNew),
        tap(() => this.isLoadingNew = true),
        switchMap((params) => this.msgService.queryMessageLog(params).pipe(
          timeout(2500),
          finalize(() => this.isLoadingNew = false),
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
            this.hasMoreNewMsg = false
          }
          this.isLoadingNew = false
          console.info('onMessageLoad 1')
          this.onMessageLoad(0)
        }
      })
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
      this.postProcessGrp({
        direction: 0, list: topList
      })
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
      this.postProcessGrp({
        direction: 1, list: botList
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
    if (derection === 0 && groupStatusArray[0]?.status === MsgGroupStatus.GENERATING) {
      console.info('one upside group generationg, can not generate more')
      return false
    } else if (derection === 1 && groupStatusArray[groupStatusArray.length - 1]?.status === MsgGroupStatus.GENERATING) {
      console.info('one downside group generationg, can not generate more')
      return false
    }
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
      if (this.hasMoreOldMsg || (!this.hasMoreOldMsg && this._oldGrpMsgIdx > 0)) {
        return this._generateOldGroup(this._oldGrpMsgIdx)
      } else {
        return false
      }
    } else {
      if (this.hasMoreNewMsg || (!this.hasMoreNewMsg && this._newGrpMsgIdx < this.messageList.length)) {
        return this._generateNewGroup(this._newGrpMsgIdx)
      } else {
        return false
      }
    }
  }

  loadMoreOldMsg() {
    console.info('loadMoreOldMsg')
    if (!this.hasMoreOldMsg) {
      console.info('has no more old message, shold not load.')
      return
    }
    let threadIdNum = this.threadIdNum
    const startId = this._startMsgId, oldestMsg = this.messageList[0]
    if (oldestMsg) {
      console.info('delta query more old data')
      this.queryOldMessages.next({
        threadId: threadIdNum, take: TAKE_NUM, skip: 1,
        lastId: oldestMsg.id, orderBy: 'desc'
      })
    }
    else {
      if (startId) {
        console.info('first query old group with startId')
        this.queryOldMessages.next({
          threadId: threadIdNum, take: TAKE_NUM, skip: 1,
          lastId: startId, orderBy: 'desc'
        })
      } else {
        console.info('first query old group')
        this.queryOldMessages.next({
          threadId: threadIdNum, take: TAKE_NUM, skip: 0,
          orderBy: 'desc'
        })
      }
    }
  }

  loadMoreNewMsg() {
    console.info('loadMoreNewMsg')
    if (!this.hasMoreNewMsg) {
      console.info('has no more new message, shold not load.')
      return
    }
    let threadIdNum = this.threadIdNum
    const startId = this._startMsgId, messageList = this.messageList
    const newestMsg = messageList[messageList.length - 1]
    if (newestMsg) {
      console.info('delta query more new data')
      this.queryNewMessages.next({
        threadId: threadIdNum,
        orderBy: 'asc',
        take: TAKE_NUM,
        skip: 1,
        lastId: newestMsg.id
      })
    } else {
      if (startId) {
        console.info('first query new group with startId')
        this.queryNewMessages.next({
          threadId: threadIdNum,
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
      threadId: this.threadIdNum
    })
    const getMyInfo = this.msgService.getMyProfile()
    this.initSglUsrPf$ = forkJoin([getThreadInfo, getMyInfo]).pipe(mergeMap(([thread, profile]) => {
      this.msgThread = thread
      this.profileRecord[profile.id] = { id: profile.id, uniqName: profile.uniqName, isSelf: true }
      const { userId1, userId2 } = thread.threadItem.info
      const friendId = userId1 === profile.id ? userId2 : userId1
      return this.msgService.queryFriendInfo({ userId: friendId })
    }))

    this.initSglUsrPf$.subscribe(res => {
      const friendProfile = res.friendUser
      this.profileRecord[friendProfile.id] = { id: friendProfile.id, uniqName: friendProfile.uniqName, isSelf: false }
      this.onThreadInit({
        title: friendProfile.uniqName
      })
    })
  }

  onMessageLoad(direction: number) {
    this.cb.onMessageLoad(direction)
  }

  onThreadInit(info: ThreadInfo) {
    this.cb.onThreadInit(info)
  }

  destroy() {
    this.subNewMessages.unsubscribe();
    this.subOldMessages.unsubscribe();
  }

  async postProcessGrp({ direction, list }: { direction: 0 | 1, list: Message[] }) {
    const { isFullfill, dispList, userIdSet } = this.buildDispDict(list)
    console.log(isFullfill, dispList, userIdSet)
    if (isFullfill) {
      this.onGrpAdded({
        direction, list: [{ id: dispList[0].id, list: dispList }], status: MsgGroupStatus.RENDERING
      })
    } else {
      this.onGrpAdded({
        direction, list: [], status: MsgGroupStatus.GENERATING
      })
      await this.queryMissingProfile(Array.from(userIdSet))
      this.updateGeneratingGrp(direction, list)
    }
  }

  async queryMissingProfile(ids: number[]) {
    await firstValueFrom(this.initSglUsrPf$)
  }

  buildDispDict(list: Message[], isForce = false) {
    const profileRecord = this.profileRecord
    let isFullfill = true, userIdSet = new Set<number>(), dispList: DisplayMsg[] = []
    const today = dayjs()
    for (let i = 0; i < list.length; i++) {
      const msg = list[i]
      const profile = profileRecord[msg.creator]
      if (profile === undefined) {
        isFullfill = false
        userIdSet.add(msg.creator)
      } else if (isFullfill || isForce) {
        const day = dayjs(msg.createdAt);
        const isToday = day.isSame(today);
        // const isYesterday = day.isSame(dayjs().subtract(1, 'day'))
        const isSameYear = day.isSame(today, 'year')
        dispList.push({
          id: msg.id,
          lines: msg.content.split('\n'),
          creatorName: profile.uniqName,
          isSelf: profile.isSelf,
          createdAt: isToday ? day.format('hh:mm') : isSameYear ?
            day.format('MM-DD hh:mm') : day.format('YYYY-MM-DD hh:mm')
        })
      }
    }
    return { dispList, isFullfill, userIdSet }
  }

  updateGeneratingGrp(direction: number, list: Message[]) {
    const { dispList } = this.buildDispDict(list, true)
    if (direction === 0) {
      this.onGrpUpdate(0, dispList, MsgGroupStatus.RENDERING)
    } else {
      this.onGrpUpdate(1, dispList, MsgGroupStatus.RENDERING)
    }
  }

  onGrpUpdate(direction: number, dispList: DisplayMsg[], status: MsgGroupStatus) {
    if (direction === 0) {
      this.groupList.set([{ id: dispList[0].id, list: dispList }].concat(this.groupList().slice(1)))
      this.groupStatusArray.set([{ status, height: 0 }].concat(this.groupStatusArray().slice(1)))
    } else {
      const gropList = this.groupList()
      const groupStatusArray = this.groupStatusArray()
      this.groupList.set(gropList.slice(0, gropList.length - 1).concat([{ id: dispList[0].id, list: dispList }]))
      this.groupStatusArray.set(groupStatusArray.slice(groupStatusArray.length - 1).concat([{ status, height: 0 }]))
    }
  }

  onGrpAdded({ direction, list, status }: GrpAddInfo) {
    const arr = Array(list.length).fill({ status, height: 0 })
    if (direction === 0) {
      this.groupStatusArray.set(arr.concat(this.groupStatusArray()))
      this.groupList.set(list.concat(this.groupList()))
    } else {
      this.groupStatusArray.set(this.groupStatusArray().concat(arr))
      this.groupList.set(this.groupList().concat(list))
    }
  }

  updateGrpStatus({ index, status, height }: { index: number, status: MsgGroupStatus, height: number }) {
    console.log('updateGrpStatus',index, status, height,this.groupStatusArray())
    if (status === MsgGroupStatus.PREPARED) {
      console.info(`new group[${index}] prepared, start checkAndBuildGroup`)
      const array = this.groupStatusArray()
      const newItem = {
        status: status,
        height: height
      }
      const newArr = array.slice(0, index).concat(newItem).concat(array.slice(index + 1))
      this.groupStatusArray.set(newArr)
    }
  }

  calcPreparedHeight() {
    const statusList = this.groupStatusArray()
    let newScrollHeight = 0, upsideGroupHeight = 0,
      downsideGroupHeight = 0, isUpsideHeightEnd = false,
      isDownsideHeightBegin = false, isAllStable = true
    console.log(statusList)
    for (let i = 0; i < statusList.length; i++) {
      const item = statusList[i]
      if (item.status === MsgGroupStatus.RENDERING) {
        console.info('calculating group, waiting for it')
        return null
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
    return { newScrollHeight, upsideGroupHeight, downsideGroupHeight, isAllStable }
  }

  preparedToStable() {
    this.groupStatusArray.set(this.groupStatusArray().map(item => {
      if (item.status !== MsgGroupStatus.PREPARED) {
        return item
      } else {
        return { status: MsgGroupStatus.STABLE, height: item.height }
      }
    }
    ))
  }

  newMessageNotify() {
    this.hasMoreNewMsg = true
  }
}