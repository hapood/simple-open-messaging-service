import { signal } from '@angular/core';
import { MsgService } from '../../services/message.service'
import { Message, UserMessageThread, QueryMessageLogParams, } from '../../services/model';
import {
  Observable, of, concatMap, switchMap
} from "rxjs";
import { default as dayjs } from 'dayjs'
import { UserProfile } from '../msg-group/model';
import { MsgGroup, MsgGroupStatus, DisplayMsg, DisMsgGrp } from './model';
import { UserService } from '../../services/user.service';

//must bigger than 0
const GROUP_MSG_NUM = 10;

export class GrpWrkFlwErr extends Error {
  grpIdx: number | undefined

  constructor(message: string, grpIdx?: number) {
    super(message)
    this.grpIdx = grpIdx
  }
}

export interface GrpAddInfo {
  direction: 0 | 1,
  list: MsgGroup[],
  status: MsgGroupStatus
}

interface MsgFactCallback {
  beforeGrpRemoved: (index: number) => void
  afterMsgListAdd: (direction: 0 | 1) => void
  afterGrpReady: (index: number) => void
  onMsgThreadInit: (data: UserMessageThread) => void
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
  private userService: UserService;

  readonly grpStatArrSig = signal<MsgGroupStatus[]>([])
  readonly dispGrpList = signal<DisMsgGrp[]>([])

  _groupList: MsgGroup[] = []
  userMsgTrd: UserMessageThread
  private profileRecord: Record<string, UserProfile> = {}
  private messageList: Message[] = [];
  //_oldGrpMsgIdx+1 is the index of messageList, whitch point to oldest message
  // in current groups, maybe out of range, means message group is empty
  private _oldGrpMsgIdx = 0
  private _newGrpMsgIdx = 0
  private _newestMsgId = '0'
  private _oldestMsgId = '0'
  private _startMsgId: string | undefined
  private cb: MsgFactCallback
  private userThreadId: number
  private isQueryingOld = false
  private isQueryingNew = false

  constructor({ cb, startMsgId, userThreadId, msgService, userService, userMsgTrd }:
    { cb: MsgFactCallback, startMsgId?: string, userThreadId: number, msgService: MsgService, userService: UserService, userMsgTrd: UserMessageThread }) {
    this.cb = cb
    this._startMsgId = startMsgId
    this.userThreadId = userThreadId
    this.msgService = msgService
    this.userService = userService
    this.userMsgTrd = userMsgTrd
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
      next: (res) => {
        if (res.status === 0) {
          const list = res.data!
          if (list.length > 0) {
            const rList = list.reverse();
            this.messageList = rList.concat(this.messageList)
            const delta = rList.length
            this._oldGrpMsgIdx += delta
            this._newGrpMsgIdx += delta
            this._groupList.forEach(grp => {
              grp.sIndex += delta
              grp.eIndex += delta
            })
          }
          if (list.length < params.take) {
            const msg = this.messageList[0]
            if (msg !== undefined) {
              console.info(`_oldestMsgId set to [${msg.id}]`)
              this._oldestMsgId = msg.id
            }
          }
          if (list.length > 0) {
            console.info('old messages added to messageList')
            this.cb.afterMsgListAdd(0)
          }
        } else {

        }
        this.isQueryingOld = false
      },
      error: (err) => {
        console.error(err)
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
      next: (res) => {
        if (res.status === 0) {
          const list = res.data!
          if (list.length > 0) {
            this.messageList = this.messageList.concat(list)
            console.info('new messages added to messageList')
            this.cb.afterMsgListAdd(1)
          }
        }
        this.isQueryingNew = false
      },
      error: () => {
        this.isQueryingNew = false
      }
    })
  }

  private _startToBldOldGrp(endIndex: number): Observable<WorkflowGenerateResult> {
    //endIndex message will not appeared in generated group
    const messageList = this.messageList
    console.info(`_startToBldOldGrp to index [${endIndex}]`)
    // for keeping group style stable, addition one take and may be droped after
    let takeNum = GROUP_MSG_NUM + 1
    let startIndex = endIndex - takeNum;
    if (endIndex < 1) {
      this._loadMoreOldMsg()
      throw new GrpWrkFlwErr('no more local old message, quit workflow and turn to load')
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
      if (this._loadMoreOldMsg() === true) {
        throw new GrpWrkFlwErr('for keeping group style stable, must quit workflow and turn to load')
      }
      //if no more remote old message, continue workflow with final topList
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
      throw new GrpWrkFlwErr('no more local new message, quit workflow and turn to load')
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
    const userThreadId = this.userThreadId
    const startId = this._startMsgId, oldestMsg = this.messageList[0]
    let params!: QueryMessageLogParams, curOldestMsgId = '-1'
    if (oldestMsg !== undefined) {
      console.info('delta query more old data')
      params = {
        userThreadId, take: GROUP_MSG_NUM, skip: 1,
        lastId: oldestMsg.id, orderBy: 'desc'
      }
      curOldestMsgId = oldestMsg.id
    }
    //when first query old message, get one more item to keep group style stable
    else if (startId !== undefined) {
      console.info('first query old group with startId')
      this._queryOldMsgs({
        userThreadId, take: GROUP_MSG_NUM + 1, skip: 1,
        lastId: startId, orderBy: 'desc'
      })
      curOldestMsgId = startId
    } else {
      console.info('first query old group')
      params = {
        userThreadId, take: GROUP_MSG_NUM + 1, skip: 0,
        orderBy: 'desc'
      }
    }
    if (curOldestMsgId < this._oldestMsgId) {
      this._queryOldMsgs(params)
      //return true when remote old message existed
      return true
    } else {
      console.info('has no more remote old message, shold not query.')
      return false
    }
  }

  _loadMoreNewMsg() {
    console.info('_loadMoreNewMsg')
    const userThreadId = this.userThreadId
    const startId = this._startMsgId, messageList = this.messageList
    const newestMsg = messageList[messageList.length - 1]
    let params!: QueryMessageLogParams, curNewestMsgId!: string
    if (newestMsg !== undefined) {
      console.info('delta query more new data')
      params = {
        userThreadId,
        orderBy: 'asc',
        take: GROUP_MSG_NUM,
        skip: 1,
        lastId: newestMsg.id
      }
      curNewestMsgId = newestMsg.id
    } else if (startId !== undefined) {
      console.info('first query new group with startId')
      params = {
        userThreadId,
        orderBy: 'asc',
        take: GROUP_MSG_NUM,
        skip: 0,
        lastId: startId
      }
      curNewestMsgId = startId
    } else {
      console.error('can not query new message without startId')
      return
    }
    if (curNewestMsgId < this._newestMsgId) {
      this._queryNewMsgs(params)
    } else {
      console.info('has no more remote new message, shold not query.')
    }
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
      return this._qryMisProf(Array.from(userIdSet)).pipe(switchMap(userList => {
        userList.forEach(item => {
          this.profileRecord[item.id] = { ...item, isSelf: item.id === this.userMsgTrd.userId }
        })
        const { dispList } = this._buildDispDict(grp, list, true)
        return of({ index, grp: grp, status: MsgGroupStatus.RENDERING, dispList })
      }))
    }
  }

  private _qryMisProf(ids: number[]) {
    return this.userService.queryUserInfo({ userIds: ids }).pipe(switchMap((res) => {
      if (res.status === 0) {
        return of(res.data!)
      } else {
        throw new GrpWrkFlwErr('unknow error occured while querying missing user profile')
      }
    }))
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
        contentType: msg.contentType,
        content: msg.content,
        creatorName: profile.uniqName,
        isSelf: profile.isSelf,
        createdAt: isToday ? day.format('HH:mm') : isSameYear ?
          day.format('MM-DD HH:mm') : day.format('YYYY-MM-DD HH:mm')
      }
    }

    for (let i = 0; i < list.length; i++) {
      const msg = list[i]
      let profile = profileRecord[msg.creator]
      if (profile === undefined) {
        if (isForce !== true) {
          userIdSet.add(msg.creator)
          isFullfill = false
          continue
        } else {
          profile = {
            id: -1,
            uniqName: 'Error',
            isSelf: false
          }
        }
      }
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

  newMessageNotify(msgId: string) {
    if (msgId > this._newestMsgId) {
      this._newestMsgId = msgId
    }
  }
}