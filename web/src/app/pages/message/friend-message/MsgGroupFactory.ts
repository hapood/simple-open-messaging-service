import { signal } from '@angular/core';
import { MsgService } from '../../../common/services/message.service'
import { Message, MsgThread, QueryMessageLogParams, } from '../../../common/services/Interfaces';
import {
  forkJoin, mergeMap, Observable, shareReplay, of, from,
  firstValueFrom, concatMap
} from "rxjs";
import { default as dayjs } from 'dayjs'
import { UserProfile } from './msg-group/modal';
import { MsgGroup, MsgGroupStatus, DisplayMsg } from './modal';

const TAKE_NUM = 10;
const GROUP_NUM = TAKE_NUM;

export class GrpWrkFlwErr extends Error {
  grpIdx: number | undefined

  constructor(message: string, grpIdx?: number) {
    super(message)
    this.grpIdx = grpIdx
  }
}

export interface ThreadInfo {
  title: string
}

export interface GrpAddInfo {
  direction: 0 | 1,
  list: MsgGroup[],
  status: MsgGroupStatus
}

interface MsgFactCallback {
  onThreadInit: (info: ThreadInfo) => void
  beforeGrpRemoved: (index: number) => void
  afterMsgListAdd: (direction: 0 | 1) => void
  afterGrpReady: (index: number) => void
}

type WorkflowPositionResult = {
  drct: 0 | 1,
  index: number
}

type WorkflowGenerateResult = {
  drct: 0 | 1,
  grp: MsgGroup,
  list: Message[]
}

type UpdateGroupParams = {
  index: number;
  grp: MsgGroup;
  status: MsgGroupStatus
}


export class MsgGroupFactory {
  private msgService: MsgService;

  groupList: MsgGroup[] = []
  readonly grpStatArrSig = signal<MsgGroupStatus[]>([])

  private msgThread: MsgThread | Record<string, undefined> = {}
  private profileRecord: Record<string, UserProfile> = {}
  private messageList: Message[] = [];
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
  private isQueryingOld = false
  private isQueryingNew = false

  constructor({ cb, startMsgId, threadIdNum, msgService }:
    { cb: MsgFactCallback, startMsgId?: string, threadIdNum: number, msgService: MsgService }) {
    this.cb = cb
    this._startMsgId = startMsgId
    this.threadIdNum = threadIdNum
    this.msgService = msgService
    this._initThreadInfo()
  }

  private _removeGrp(index: number) {
    this.cb.beforeGrpRemoved(index)
    const list = this.groupList, statusArr = this.grpStatArrSig()
    this.groupList = list.slice(0, index).concat(list.slice(index + 1))
    this.grpStatArrSig.set(statusArr.slice(0, index).concat(statusArr.slice(index + 1)))
  }

  private _queryOldMsgs(params: QueryMessageLogParams) {
    if (this.isQueryingOld) {
      console.info('already querying old message, stop for it')
      return
    }
    this.isQueryingOld = true
    this.msgService.queryMessageLog(params).subscribe({
      next: (list) => {
        if (list.length === 0) {
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
        console.info('old messages added to messageList')
        this.cb.afterMsgListAdd(0)
      },
      complete: () => {
        this.isQueryingOld = false
      }
    })
  }

  private _queryNewMsgs(params: QueryMessageLogParams) {
    if (this.isQueryingNew) {
      console.info('already querying new message, stop for it')
      return
    }
    this.isQueryingNew = true
    this.msgService.queryMessageLog(params).subscribe({
      next: (list) => {
        if (list.length === 0) {
          return
        }
        this.messageList = this.messageList.concat(list)
        if (list.length < TAKE_NUM) {
          console.info('no more new message to load, set hasMoreNewMsg false')
          this.hasMoreNewMsg = false
        }
        console.info('new messages added to messageList')
        this.cb.afterMsgListAdd(1)
      },
      complete: () => {
        this.isQueryingNew = false
      }
    })
  }

  private _startToBldOldGrp(endIndex: number): Observable<WorkflowGenerateResult> {
    //endIndex message will not appeared in generated group
    const messageList = this.messageList
    console.info(`_startToBldOldGrp to index [${endIndex}]`)
    let startIndex = endIndex - GROUP_NUM, takeNum = GROUP_NUM;
    if (endIndex < 1) {
      this._loadMoreOldMsg()
      throw new GrpWrkFlwErr('no more old message to take, turn to load')
    }
    if (startIndex < 0) {
      takeNum += startIndex;
      startIndex = 0;
    }
    const topList = messageList.slice(startIndex, startIndex + takeNum)
    this._oldGrpMsgIdx = startIndex - 1
    const grpStatArrSig = this.grpStatArrSig
    grpStatArrSig.set([MsgGroupStatus.GENERATING].concat(grpStatArrSig()))
    const grp = {
      id: topList[0].id,
      sIndex: startIndex,
      eIndex: startIndex + topList.length,
      list: [],
      height: 0
    }
    this.groupList.unshift(grp)
    return of({ drct: 0, grp: grp, list: topList })
  }

  private _startToBldNewGrp(startIndex: number): Observable<WorkflowGenerateResult> {
    //startIndex message will not appeared in generated group
    console.info(`_startToBldNewGrp from index [${startIndex}]`)
    const messageList = this.messageList
    const botList = messageList.slice(startIndex, startIndex + GROUP_NUM)
    if (botList.length > 0) {
      const eIndex = startIndex + botList.length
      this._newGrpMsgIdx = eIndex
      const grpStatArrSig = this.grpStatArrSig
      grpStatArrSig.set(grpStatArrSig().concat([MsgGroupStatus.GENERATING]))
      const grp = {
        id: botList[0].id,
        sIndex: startIndex,
        eIndex: eIndex,
        list: [],
        height: 0
      }
      this.groupList.push(grp)
      return of({ drct: 1, grp: grp, list: botList })
    } else {
      this._loadMoreNewMsg()
      throw new GrpWrkFlwErr('no more new message to take, turn to load')
    }
  }

  private _calcStartPosition(derection: 0 | 1): Observable<WorkflowPositionResult> {
    console.info(`calculating start position, derection[${derection}]`)
    const grpStatArrSig = this.grpStatArrSig();
    const lastGrpSts = grpStatArrSig[grpStatArrSig.length - 1]
    const firstGrpSts = grpStatArrSig[0]
    if (derection === 0 && firstGrpSts === MsgGroupStatus.GENERATING) {
      throw new GrpWrkFlwErr('one upside group generating, can not build more')
    } else if (derection === 1 && lastGrpSts === MsgGroupStatus.GENERATING) {
      throw new GrpWrkFlwErr('one downside group generating, can not build more')
    }
    if (grpStatArrSig.length === 0) {
      let startId = this._startMsgId
      if (startId) {
        const index = this.messageList.findIndex(msg => msg.id === this._startMsgId)
        return of({ drct: 0, index: index } as WorkflowPositionResult, { drct: 1, index: index } as WorkflowPositionResult)
      } else {
        return of({ drct: 0, index: this._oldGrpMsgIdx })
      }
    } else if (derection === 0) {
      if (this.hasMoreOldMsg || (!this.hasMoreOldMsg && this._oldGrpMsgIdx > 0)) {
        return of({ drct: 0, index: this._oldGrpMsgIdx })
      } else {
        throw new GrpWrkFlwErr('no more old message to build')
      }
    } else {
      if (this.hasMoreNewMsg || (!this.hasMoreNewMsg && this._newGrpMsgIdx < this.messageList.length)) {
        return of({ drct: 1, index: this._newGrpMsgIdx })
      } else {
        throw new GrpWrkFlwErr('no more new message to build')
      }
    }
  }

  _loadMoreOldMsg() {
    console.info('_loadMoreOldMsg')
    if (!this.hasMoreOldMsg) {
      console.info('has no more old message, shold not load.')
      return
    }
    let threadIdNum = this.threadIdNum
    const startId = this._startMsgId, oldestMsg = this.messageList[0]
    if (oldestMsg) {
      console.info('delta query more old data')
      this._queryOldMsgs({
        threadId: threadIdNum, take: TAKE_NUM, skip: 1,
        lastId: oldestMsg.id, orderBy: 'desc'
      })
    }
    else {
      if (startId) {
        console.info('first query old group with startId')
        this._queryOldMsgs({
          threadId: threadIdNum, take: TAKE_NUM, skip: 1,
          lastId: startId, orderBy: 'desc'

        })
      } else {
        console.info('first query old group')
        this._queryOldMsgs({
          threadId: threadIdNum, take: TAKE_NUM, skip: 0,
          orderBy: 'desc'
        })
      }
    }
  }

  _loadMoreNewMsg() {
    console.info('_loadMoreNewMsg')
    if (!this.hasMoreNewMsg) {
      console.info('has no more new message, shold not load.')
      return
    }
    let threadIdNum = this.threadIdNum
    const startId = this._startMsgId, messageList = this.messageList
    const newestMsg = messageList[messageList.length - 1]
    if (newestMsg) {
      console.info('delta query more new data')
      this._queryNewMsgs({
        threadId: threadIdNum,
        orderBy: 'asc',
        take: TAKE_NUM,
        skip: 1,
        lastId: newestMsg.id

      })
    } else {
      if (startId) {
        console.info('first query new group with startId')
        this._queryNewMsgs({
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

  _initThreadInfo() {
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
    }), shareReplay())
    this.initSglUsrPf$.subscribe(res => {
      const friendProfile = res.friendUser
      this.profileRecord[friendProfile.id] = { id: friendProfile.id, uniqName: friendProfile.uniqName, isSelf: false }
      this.cb.onThreadInit({
        title: friendProfile.uniqName
      })
    })
  }

  _procGenGrp({ drct, grp, list }: WorkflowGenerateResult): Observable<UpdateGroupParams> {
    let index = 0
    if (drct === 1) {
      index = this.groupList.length - 1
    }
    console.info(`process generating group[${index}]`)
    const { isFullfill, dispList, userIdSet } = this._buildDispDict(grp, list)
    if (isFullfill) {
      grp.list = dispList
      return of({ index, grp: grp, status: MsgGroupStatus.RENDERING })
    } else {
      return from(
        this._qryMisProf(Array.from(userIdSet)).then(() => {
          const { dispList } = this._buildDispDict(grp, list, true)
          grp.list = dispList
          return { index, grp: grp, status: MsgGroupStatus.RENDERING }
        }).catch(e => {
          throw new GrpWrkFlwErr('error occured while querying missing user profile', index)
        }))
    }
  }

  private async _qryMisProf(ids: number[]) {
    await firstValueFrom(this.initSglUsrPf$)
  }

  private _buildDispDict(grp: MsgGroup, list: Message[], isForce?: boolean) {
    const profileRecord = this.profileRecord
    let isFullfill = true, userIdSet = new Set<number>(), dispList: DisplayMsg[] = []
    const today = dayjs()
    const generateItem = (msg: Message, profile: UserProfile) => {
      const day = dayjs(msg.createdAt);
      const isToday = day.isSame(today, 'day');
      // const isYesterday = day.isSame(dayjs().subtract(1, 'day'))
      const isSameYear = day.isSame(today, 'year')
      return {
        id: msg.id,
        lines: msg.content.split('\n'),
        creatorName: profile.uniqName,
        isSelf: profile.isSelf,
        createdAt: isToday ? day.format('hh:mm') : isSameYear ?
          day.format('MM-DD hh:mm') : day.format('YYYY-MM-DD hh:mm')
      }
    }

    for (let i = 0; i < list.length; i++) {
      const msg = list[i]
      const profile = profileRecord[msg.creator]
      if (profile === undefined) {
        isFullfill = false
        userIdSet.add(msg.creator)
      } else if (isFullfill || isForce) {
        const newItem = generateItem(msg, profile) as DisplayMsg
        const nextItem = this.messageList[grp.eIndex]
        newItem.isDateShrink = (nextItem !== undefined) && dayjs(nextItem.createdAt).isSame(msg.createdAt)
        const prevItem = this.messageList[grp.sIndex - 1]
        newItem.isShowHead = prevItem?.creator !== msg.creator
        newItem.isDateShrink = false
        dispList.push(newItem)
      }
    }
    return { dispList, isFullfill, userIdSet }
  }

  private _undateGrp({ index, grp, status }: UpdateGroupParams) {
    const groupList = this.groupList
    const grpStatArrSig = this.grpStatArrSig()
    groupList[index] = grp
    this.grpStatArrSig.set(grpStatArrSig.slice(0, index).concat([status]).concat(grpStatArrSig.slice(index + 1)))
    return of(index)
  }

  startBuild(direction: 0 | 1) {
    of(direction).pipe(
      concatMap((direction) => this._calcStartPosition(direction)),
      concatMap(({ drct, index }) => {
        if (drct === 0) {
          return this._startToBldOldGrp(index)
        } else {
          return this._startToBldNewGrp(index)
        }
      }),
      concatMap((params) => this._procGenGrp(params)),
      concatMap(params => this._undateGrp(params)),
    ).subscribe({
      next: (index) => {
        this.cb.afterGrpReady(index)
      },
      error: (e) => {
        if (e instanceof GrpWrkFlwErr) {
          console.info(`[GrpWrkFlwErr]:${e.message}`)
          if (e.grpIdx !== undefined) {
            this._removeGrp(e.grpIdx)
          }
        }
      }
    })
  }

  calcPreparedHeight() {
    const statusList = this.grpStatArrSig()
    let newScrollHeight = 0, upsideGroupHeight = 0,
      downsideGroupHeight = 0, isUpsideHeightEnd = false,
      isDownsideHeightBegin = false, isAllStable = true
    for (let i = 0; i < statusList.length; i++) {
      const status = statusList[i]
      if (status === MsgGroupStatus.RENDERING) {
        console.info('calculating group, waiting for it')
        return null
      } else if (status === MsgGroupStatus.STABLE) {
        isUpsideHeightEnd = true
      } else if (status === MsgGroupStatus.PREPARED) {
        isAllStable = false
        if (isUpsideHeightEnd) {
          isDownsideHeightBegin = true
        }
      }
      const grp = this.groupList[i]
      if (!isUpsideHeightEnd) {
        upsideGroupHeight += grp.height
      } else if (isDownsideHeightBegin) {
        downsideGroupHeight += grp.height
      }
      newScrollHeight += grp.height
    }
    return { newScrollHeight, upsideGroupHeight, downsideGroupHeight, isAllStable }
  }

  preparedToStable() {
    this.grpStatArrSig.set(this.grpStatArrSig().map(status => {
      if (status !== MsgGroupStatus.PREPARED) {
        return status
      } else {
        return MsgGroupStatus.STABLE
      }
    }
    ))
  }

  updateGrpheight({ index, height }: { index: number, height: number }) {
    console.info(`group index [${index}] height changed from [${this.groupList[index].height}] to [${height}]`)
    this.groupList[index].height = height
    const statusArr = this.grpStatArrSig()
    if (height > 0 && statusArr[index] === MsgGroupStatus.RENDERING) {
      this.grpStatArrSig.set(statusArr.slice(0, index).concat([MsgGroupStatus.PREPARED]).concat(statusArr.slice(index + 1)))
    }
  }

  newMessageNotify() {
    this.hasMoreNewMsg = true
  }
}