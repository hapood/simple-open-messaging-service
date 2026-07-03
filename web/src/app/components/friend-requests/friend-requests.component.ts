import { Component, input, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FormsModule } from '@angular/forms';
import { UserService, User } from '../../services/user.service';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { MsgService } from '../../services/message.service'
import { translateBizResult } from '../../services/biz-code'
import { arrayToDictIndex } from '../../../utils';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';
import dayjs from 'dayjs';

enum AddTabStatus {
  INIT, EMPTY, SEARCHING, SUCCESS, ERROR
}
// The underlying User data is optional: the degraded "Unknown user" fallback row
// (built when a pending/sent request's user can't be resolved) lacks userExtra,
// so the avatar falls back to the initial letter. Resolved rows spread a full User.
type PendingReq = Omit<User, 'userExtra'> & { userExtra?: User['userExtra'] }
  & { status: number, date: string, errText: string }

@Component({
    selector: 'app-friend-requests',
    imports: [UserAvatarComponent, FormsModule,
        MatButtonModule, IconComponent, FitDialogDirective, TranslocoPipe],
    templateUrl: './friend-requests.component.html',
    styleUrl: './friend-requests.component.scss'
})
export class FriendRequestsComponent {
  readonly fitOpts = { minHeight: 420 } as const
  readonly searchText = signal('')
  readonly userData = signal<User | undefined>(undefined)
  readonly errMsg = signal('')
  readonly reqRspTxt = signal('')
  readonly addTabStatus = signal<AddTabStatus>(AddTabStatus.INIT)
  readonly canAdd = signal(false)
  readonly curSearchText = signal('')
  readonly pendingReqList = signal([] as PendingReq[])
  readonly toPendingErrTxt = signal('')
  readonly pendingLoading = signal(true)
  readonly sentReqList = signal([] as PendingReq[])
  readonly sentErrTxt = signal('')
  readonly sentLoading = signal(true)

  subject = input<Subject<any> | undefined>(undefined)
  activeTab = signal(0)
  isShowBackBtn = signal(true)

  UserAvatarType = UserAvatarType
  AddTabStatus = AddTabStatus
  AppIconType = AppIconType

  constructor(private routeService: RouteService, private userService: UserService, private msgService: MsgService, private transloco: TranslocoService) {
  }
  setTab(tab: number) {
    this.activeTab.set(tab)
  }

  goBack() {
    this.routeService.closeDlg()
  }

  searchUser() {
    const curSearchText = this.searchText().trim()
    if (!curSearchText) return
    this.addTabStatus.set(AddTabStatus.SEARCHING)
    this.reqRspTxt.set('')
    this.userService.getUserInfoByUniqName({ uniqName: curSearchText }).subscribe({
      next: res => {
        if (res.code === 0) {
          if (res.data!.uniqName === this.userService.sessionProfile()!.uniqName) {
            this.userData.set(res.data)
            this.addTabStatus.set(AddTabStatus.SUCCESS)
            this.canAdd.set(false)
            this.reqRspTxt.set(this.transloco.translate('friend.error.canNotAddSelf'))
          } else {
            // First query the P2P thread status with this user to decide which state applies
            // (can add / already friends / request already sent / they sent one to you), instead of
            // always showing Send Request (avoids re-inviting an existing friend and misleading copy).
            this.msgService.getThreadByUserId({ userId: res.data!.id }).subscribe(res2 => {
              this.userData.set(res.data)
              this.addTabStatus.set(AddTabStatus.SUCCESS)
              if (res2.code === 30003) {
                // THREAD_NOT_FOUND: no relationship yet — a friend request can be sent.
                this.canAdd.set(true)
                this.reqRspTxt.set('')
                return
              }
              if (res2.code !== 0) {
                this.canAdd.set(true)
                this.reqRspTxt.set('')
                return
              }
              switch (res2.data?.status) {
                case 'APPROVED':
                  this.canAdd.set(false)
                  this.reqRspTxt.set(this.transloco.translate('friend.error.alreadyFriends'))
                  break
                case 'PENDING':
                  // Direction disambiguates incoming vs outgoing (the friendship is one row per pair).
                  if (res2.data?.requesterId === this.userService.sessionProfile()!.id) {
                    this.canAdd.set(false)
                    this.reqRspTxt.set(this.transloco.translate('friend.error.requestAlreadySent'))
                  } else {
                    // They already sent you a request → guide to the Pending tab to accept, not re-send.
                    this.canAdd.set(false)
                    this.reqRspTxt.set(this.transloco.translate('friend.error.sentYouRequest'))
                  }
                  break
                default:
                  // BLOCKED / DELETED still allow (re)sending.
                  this.canAdd.set(true)
                  this.reqRspTxt.set('')
              }
            })
          }
        } else {
          this.curSearchText.set(curSearchText)
          this.addTabStatus.set(AddTabStatus.EMPTY)
        }
      }, error: () => {
        this.errMsg.set(this.transloco.translate('friend.error.unknownError'))
        this.addTabStatus.set(AddTabStatus.ERROR)
      }
    })
  }

  sendRequest() {
    this.reqRspTxt.set('')
    this.userService.sendFriendRequest({ userId: this.userData()!.id }).subscribe({
      next: res => {
        // Echo the backend message directly: the backend already returns status-keyed copy
        // ("friend request sent" / "you are already friends" / "you are now friends"), so the
        // client does not hardcode a "sent successfully" string.
        this.reqRspTxt.set(translateBizResult(res, this.transloco))
      }, error: () => {
        this.reqRspTxt.set(this.transloco.translate('friend.error.unknownError'))
      }
    })
  }

  approve(index: number) {
    const req = this.pendingReqList()[index]
    this.userService.approveFriendRequest({ userId: req.id }).subscribe(res => {
      const reqList = this.pendingReqList()
      if (res.code === 0) {
        this.pendingReqList.set(reqList.slice(0, index).concat([{ ...req, status: 1, errText: '' }]).concat(reqList.slice(index + 1)))
      } else {
        this.pendingReqList.set(reqList.slice(0, index).concat([{ ...req, status: 0, errText: translateBizResult(res, this.transloco) }]).concat(reqList.slice(index + 1)))
      }
    })

  }

  decline(index: number) {
    const req = this.pendingReqList()[index]
    this.userService.declineFriendRequest({ userId: req.id }).subscribe(res => {
      if (res.code === 0) {
        // Decline succeeded: the request row is soft-deleted (DELETED); remove it from the pending
        // list (filter by id to avoid index drift).
        this.pendingReqList.set(this.pendingReqList().filter(r => r.id !== req.id))
      } else {
        // Failed: keep it in the list and tag the error copy (errText always renders in the template).
        this.pendingReqList.set(this.pendingReqList().map(r => r.id === req.id ? { ...r, errText: translateBizResult(res, this.transloco) } : r))
      }
    })
  }

  cancelSent(index: number) {
    const req = this.sentReqList()[index]
    this.userService.cancelFriendRequest({ userId: req.id }).subscribe(res => {
      if (res.code === 0) {
        // Cancel succeeded: our request row is set to DELETED; remove it from the sent list
        // (filter by id to avoid index drift).
        this.sentReqList.set(this.sentReqList().filter(r => r.id !== req.id))
      } else {
        // Failed: keep it in the list and tag the error copy.
        this.sentReqList.set(this.sentReqList().map(r => r.id === req.id ? { ...r, errText: translateBizResult(res, this.transloco) } : r))
      }
    })
  }

  ngOnInit() {
    this.userService.queryToPending({ take: 20, beforeDate: new Date().getTime() }).subscribe({
      next: (res) => {
        if (res.code !== 0) {
          this.toPendingErrTxt.set(this.transloco.translate('friend.error.unknownError'))
          this.pendingLoading.set(false)
          return
        }
        const userIds = res.data!.map(item => item.peerUserId)
        this.userService.queryUserInfo({ userIds }).subscribe({
          next: (res2) => {
            if (res2.code !== 0) {
              this.toPendingErrTxt.set(this.transloco.translate('friend.error.unknownError'))
              this.pendingLoading.set(false)
              return
            }
            const dict = arrayToDictIndex(res2.data!, 'id')
            const list = res.data!.map(item => {
              const userData = dict[item.peerUserId]
              if (userData) {
                return { ...userData, status: 0, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss'), errText: '' }
              } else {
                return { id: item.peerUserId, uniqName: this.transloco.translate('common.unknownUser'), status: -1, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss'), errText: '' } as PendingReq
              }
            })
            this.pendingReqList.set(list)
            this.pendingLoading.set(false)
          },
          error: () => {
            this.toPendingErrTxt.set(this.transloco.translate('friend.error.unknownError'))
            this.pendingLoading.set(false)
          },
        })
      },
      error: (err) => {
        this.toPendingErrTxt.set(this.transloco.translate('friend.error.unknownError'))
        this.pendingLoading.set(false)
      },
    })

    this.userService.queryFromPending({ take: 20, beforeDate: new Date().getTime() }).subscribe({
      next: (res) => {
        if (res.code !== 0) {
          this.sentErrTxt.set(this.transloco.translate('friend.error.unknownError'))
          this.sentLoading.set(false)
          return
        }
        const userIds = res.data!.map(item => item.peerUserId)
        this.userService.queryUserInfo({ userIds }).subscribe({
          next: (res2) => {
            if (res2.code !== 0) {
              this.sentErrTxt.set(this.transloco.translate('friend.error.unknownError'))
              this.sentLoading.set(false)
              return
            }
            const dict = arrayToDictIndex(res2.data!, 'id')
            const list = res.data!.map(item => {
              const userData = dict[item.peerUserId]
              if (userData) {
                return { ...userData, status: 0, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss'), errText: '' }
              } else {
                return { id: item.peerUserId, uniqName: this.transloco.translate('common.unknownUser'), status: -1, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss'), errText: '' } as PendingReq
              }
            })
            this.sentReqList.set(list)
            this.sentLoading.set(false)
          },
          error: () => {
            this.sentErrTxt.set(this.transloco.translate('friend.error.unknownError'))
            this.sentLoading.set(false)
          },
        })
      },
      error: (err) => {
        this.sentErrTxt.set(this.transloco.translate('friend.error.unknownError'))
        this.sentLoading.set(false)
      },
    })

    // Opening the panel counts as "seen" → clear the friend-request unread badge (the backend writes
    // hasUrFriendReq=false, then we refresh the local profile).
    this.userService.markFriendReqRead().subscribe(() => this.userService.updateSessionProfile())
  }
}
