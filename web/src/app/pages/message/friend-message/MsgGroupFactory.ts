import { signal } from '@angular/core';
import { MsgService } from '../../../services/message.service'
import { Message, MsgThread, QueryMessageLogParams, } from '../../../services/Interfaces';
import {
  forkJoin, mergeMap, Observable, shareReplay, of, from,
  firstValueFrom, concatMap
} from "rxjs";
import { default as dayjs } from 'dayjs'
import { UserProfile } from './msg-group/modal';
import { MsgGroup, MsgGroupStatus, DisplayMsg, DisMsgGrp } from './modal';

//must bigger than 0
const GROUP_MSG_NUM = 10;

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
  status: MsgGroupStatus;
  dispList: DisplayMsg[]
}


export class MsgGroupFactory {
  private msgService: MsgService;

  readonly grpStatArrSig = signal<MsgGroupStatus[]>([])
  readonly dispGrpList = signal<DisMsgGrp[]>([])

  _groupList: MsgGroup[] = []
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
    const grpList = this._groupList, statusArr = this.grpStatArrSig(), dispGrpList = this.dispGrpList()
    this._groupList = grpList.slice(0, index).concat(grpList.slice(index + 1))
    this.dispGrpList.set(dispGrpList.slice(0, index).concat(dispGrpList.slice(index + 1)))
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
        const delta = rList.length
        this._oldGrpMsgIdx += delta
        this._newGrpMsgIdx += delta
        this._groupList.forEach(grp => {
          grp.sIndex += delta
          grp.eIndex += delta
        })
        if (list.length < params.take) {
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
        if (list.length < params.take) {
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
    if (!this.hasMoreOldMsg && this._oldGrpMsgIdx < 0) {
      throw new GrpWrkFlwErr('no more old message to build')
    }
    const messageList = this.messageList
    console.info(`_startToBldOldGrp to index [${endIndex}]`)
    // for keeping group style stable, addition one take and may be droped after
    let takeNum = GROUP_MSG_NUM + 1
    let startIndex = endIndex - takeNum;
    if (endIndex < 1) {
      this._loadMoreOldMsg()
      throw new GrpWrkFlwErr('no more old message, quit workflow and turn to load')
    }
    if (startIndex < 0) {
      takeNum += startIndex;
      startIndex = 0;
    }
    let topList = messageList.slice(startIndex, startIndex + takeNum)
    // for keeping group style stable, when has more unloaded old message, first message do not display
    if (topList.length > 1) {
      topList = topList.slice(1)
      startIndex += 1
    } else {
      if (this.hasMoreOldMsg) {
        this._loadMoreOldMsg()
        throw new GrpWrkFlwErr('for keeping group style stable, must quit workflow and turn to load')
      }
    }
    this._oldGrpMsgIdx = startIndex
    const grpStatArrSig = this.grpStatArrSig, dispGrpList = this.dispGrpList()
    grpStatArrSig.set([MsgGroupStatus.GENERATING].concat(grpStatArrSig()))
    const grp = {
      id: topList[0].id,
      sIndex: startIndex,
      eIndex: startIndex + topList.length,
      height: 0
    }
    this.dispGrpList.set([{ id: topList[0].id, list: [] as DisplayMsg[] }].concat(dispGrpList))
    this._groupList.unshift(grp)
    return of({ drct: 0, grp: grp, list: topList })
  }

  private _startToBldNewGrp(startIndex: number): Observable<WorkflowGenerateResult> {
    if (!this.hasMoreNewMsg && this._newGrpMsgIdx > this.messageList.length - 1) {
      throw new GrpWrkFlwErr('no more new message to build')
    }
    //startIndex message will not appeared in generated group
    console.info(`_startToBldNewGrp from index [${startIndex}]`)
    const messageList = this.messageList
    const botList = messageList.slice(startIndex, startIndex + GROUP_MSG_NUM)
    if (botList.length > 0) {
      const eIndex = startIndex + botList.length
      this._newGrpMsgIdx = eIndex
      const grpStatArrSig = this.grpStatArrSig, dispGrpList = this.dispGrpList()
      grpStatArrSig.set(grpStatArrSig().concat([MsgGroupStatus.GENERATING]))
      const grp = {
        id: botList[0].id,
        sIndex: startIndex,
        eIndex: eIndex,
        height: 0
      }
      this.dispGrpList.set(dispGrpList.concat([{ id: botList[0].id, list: [] as DisplayMsg[] }]))
      this._groupList.push(grp)
      return of({ drct: 1, grp: grp, list: botList })
    } else {
      this._loadMoreNewMsg()
      throw new GrpWrkFlwErr('no more new message, quit workflow and turn to load')
    }
  }

  private _calcStartPosition(derection: 0 | 1): Observable<WorkflowPositionResult> {
    console.info(`calculating start position, derection[${derection}]`)
    const grpStatArrSig = this.grpStatArrSig();
    const lastGrpSts = grpStatArrSig[grpStatArrSig.length - 1]
    const fstGrpSts = grpStatArrSig[0]
    if (derection === 0 && fstGrpSts === MsgGroupStatus.GENERATING) {
      throw new GrpWrkFlwErr('one upside group generating, can not build more')
    } else if (derection === 1 && lastGrpSts === MsgGroupStatus.GENERATING) {
      throw new GrpWrkFlwErr('one downside group generating, can not build more')
    }
    if (grpStatArrSig.length === 0) {
      let startId = this._startMsgId
      if (startId) {
        // when start form middle, both direction are generating
        const index = this.messageList.findIndex(msg => msg.id === this._startMsgId)
        return of({ drct: 0, index: index } as WorkflowPositionResult, { drct: 1, index: index } as WorkflowPositionResult)
      } else {
        return of({ drct: 0, index: this._oldGrpMsgIdx })
      }
    } else if (derection === 0) {
      return of({ drct: 0, index: this._oldGrpMsgIdx })
    } else {
      return of({ drct: 1, index: this._newGrpMsgIdx })
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
        threadId: threadIdNum, take: GROUP_MSG_NUM, skip: 1,
        lastId: oldestMsg.id, orderBy: 'desc'
      })
    }
    else {
      //when first query old message, get one more item to keep group style stable
      if (startId) {
        console.info('first query old group with startId')
        this._queryOldMsgs({
          threadId: threadIdNum, take: GROUP_MSG_NUM + 1, skip: 1,
          lastId: startId, orderBy: 'desc'

        })
      } else {
        console.info('first query old group')
        this._queryOldMsgs({
          threadId: threadIdNum, take: GROUP_MSG_NUM + 1, skip: 0,
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
        take: GROUP_MSG_NUM,
        skip: 1,
        lastId: newestMsg.id

      })
    } else {
      if (startId) {
        console.info('first query new group with startId')
        this._queryNewMsgs({
          threadId: threadIdNum,
          orderBy: 'asc',
          take: GROUP_MSG_NUM,
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
      index = this._groupList.length - 1
    }
    console.info(`process generating group[${index}]`)
    const { isFullfill, dispList, userIdSet } = this._buildDispDict(grp, list)
    if (isFullfill) {
      return of({ index, grp: grp, status: MsgGroupStatus.RENDERING, dispList })
    } else {
      return from(
        this._qryMisProf(Array.from(userIdSet)).then(() => {
          const { dispList } = this._buildDispDict(grp, list, true)
          return { index, grp: grp, status: MsgGroupStatus.RENDERING, dispList }
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
        createdAt: isToday ? day.format('HH:mm') : isSameYear ?
          day.format('MM-DD HH:mm') : day.format('YYYY-MM-DD HH:mm')
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
        let nextItem = list[i + 1];
        if (nextItem === undefined) {
          nextItem = this.messageList[grp.eIndex]
        }
        let prevItem = list[i - 1]
        if (prevItem === undefined) {
          prevItem = this.messageList[grp.sIndex - 1]
        }
        const isDiffUser = prevItem?.creator !== msg.creator
        newItem.isDateShrink = false && isDiffUser || (nextItem !== undefined) && dayjs(nextItem.createdAt).isSame(dayjs(msg.createdAt), 'minute')
        newItem.isShowHead = isDiffUser || prevItem === undefined || !dayjs(prevItem.createdAt).isSame(dayjs(msg.createdAt), 'minute')
        dispList.push(newItem)
      }
    }
    return { dispList, isFullfill, userIdSet }
  }

  private _undateGrp({ index, grp, status, dispList }: UpdateGroupParams) {
    const groupList = this._groupList, dispGrpList = this.dispGrpList()
    if (groupList[index] === grp) {
      const prevDipGrp = dispGrpList[index - 1], nextDipGrp = dispGrpList[index + 1];
      //only new group will affect old group, old group never affect mew one
      if (prevDipGrp !== undefined) {
        const isDirty = false
        const prevDipList = prevDipGrp.list
        //TODO
        if (isDirty) {
          dispGrpList[index - 1] = { id: prevDipGrp.id, list: prevDipList }
        }
      }
      const grpStatArrSig = this.grpStatArrSig()
      this.dispGrpList.set(dispGrpList.slice(0, index).concat([{ id: grp.id, list: dispList }]).concat(dispGrpList.slice(index + 1)))
      this.grpStatArrSig.set(grpStatArrSig.slice(0, index).concat([status]).concat(grpStatArrSig.slice(index + 1)))
      return of(index)
    } else {
      throw new GrpWrkFlwErr('old group had been removed, quit workflow.')
    }
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
        } else {
          console.error(e)
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
      const grp = this._groupList[i]
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
    const lastHeight = this._groupList[index].height
    if (lastHeight !== height) {
      console.info(`group index [${index}] height changed from [${lastHeight}] to [${height}]`)
      const statusArr = this.grpStatArrSig()
      const curStatus = statusArr[index]
      if (curStatus === MsgGroupStatus.RENDERING) {
        if (height > 0) {
          this.grpStatArrSig.set(statusArr.slice(0, index).concat([MsgGroupStatus.PREPARED]).concat(statusArr.slice(index + 1)))
        }
      }
      this._groupList[index].height = height
    }
  }

  newMessageNotify() {
    this.hasMoreNewMsg = true
  }
}