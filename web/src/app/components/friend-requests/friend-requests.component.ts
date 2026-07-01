import { Component, input, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FormsModule } from '@angular/forms';
import { UserService, User } from '../../services/user.service';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { MsgService } from '../../services/message.service'
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
        MatButtonModule, IconComponent, FitDialogDirective],
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

  constructor(private routeService: RouteService, private userService: UserService, private msgService: MsgService) {
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
            this.reqRspTxt.set('can not add yourself')
          } else {
            // 先查与该用户的 P2P 会话状态，据此决定「可加 / 已是好友 / 已发过 / 对方发过你」，
            // 而非一律显示 Send Request（避免对已是好友的人再次发起、文案误导）。
            this.msgService.getThreadByUserId({ userId: res.data!.id }).subscribe(res2 => {
              this.userData.set(res.data)
              this.addTabStatus.set(AddTabStatus.SUCCESS)
              if (res2.code === 30003) {
                // THREAD_NOT_FOUND：尚无任何关系，可发起好友请求
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
                  this.reqRspTxt.set('already friends')
                  break
                case 'PENDING':
                  // Direction disambiguates incoming vs outgoing (the friendship is one row per pair).
                  if (res2.data?.requesterId === this.userService.sessionProfile()!.id) {
                    this.canAdd.set(false)
                    this.reqRspTxt.set('friend request already sent')
                  } else {
                    // 对方已发请求给你 → 引导去 Pending 标签同意，而非重复发起
                    this.canAdd.set(false)
                    this.reqRspTxt.set('sent you a request — check Pending')
                  }
                  break
                default:
                  // BLOCKED / DELETED 仍允许（重新）发起
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
        this.errMsg.set('unknown error occurred')
        this.addTabStatus.set(AddTabStatus.ERROR)
      }
    })
  }

  sendRequest() {
    this.reqRspTxt.set('')
    this.userService.sendFriendRequest({ userId: this.userData()!.id }).subscribe({
      next: res => {
        // 直接回显后端 message：B2 已按状态返回「friend request sent / you are already friends /
        // you are now friends」，前端不再写死 "sent successfully"。
        this.reqRspTxt.set(res.message)
      }, error: () => {
        this.reqRspTxt.set('unknown error occurred')
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
        this.pendingReqList.set(reqList.slice(0, index).concat([{ ...req, status: 0, errText: res.message }]).concat(reqList.slice(index + 1)))
      }
    })

  }

  decline(index: number) {
    const req = this.pendingReqList()[index]
    this.userService.declineFriendRequest({ userId: req.id }).subscribe(res => {
      if (res.code === 0) {
        // 拒绝成功：请求行已软删除（DELETED），从待处理列表移除（按 id 过滤，规避索引漂移）
        this.pendingReqList.set(this.pendingReqList().filter(r => r.id !== req.id))
      } else {
        // 失败：保留在列表并标记错误文案（errText 在模板中恒定渲染）
        this.pendingReqList.set(this.pendingReqList().map(r => r.id === req.id ? { ...r, errText: res.message } : r))
      }
    })
  }

  cancelSent(index: number) {
    const req = this.sentReqList()[index]
    this.userService.cancelFriendRequest({ userId: req.id }).subscribe(res => {
      if (res.code === 0) {
        // 撤销成功：我方请求行置 DELETED，从已发送列表移除（按 id 过滤，规避索引漂移）
        this.sentReqList.set(this.sentReqList().filter(r => r.id !== req.id))
      } else {
        // 失败：保留在列表并标记错误文案
        this.sentReqList.set(this.sentReqList().map(r => r.id === req.id ? { ...r, errText: res.message } : r))
      }
    })
  }

  ngOnInit() {
    this.userService.queryToPending({ take: 20, beforeDate: new Date().getTime() }).subscribe({
      next: (res) => {
        if (res.code !== 0) {
          this.toPendingErrTxt.set('unknown error occurred')
          this.pendingLoading.set(false)
          return
        }
        const userIds = res.data!.map(item => item.peerUserId)
        this.userService.queryUserInfo({ userIds }).subscribe({
          next: (res2) => {
            if (res2.code !== 0) {
              this.toPendingErrTxt.set('unknown error occurred')
              this.pendingLoading.set(false)
              return
            }
            const dict = arrayToDictIndex(res2.data!, 'id')
            const list = res.data!.map(item => {
              const userData = dict[item.peerUserId]
              if (userData) {
                return { ...userData, status: 0, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss'), errText: '' }
              } else {
                return { id: item.peerUserId, uniqName: 'Unknown user', status: -1, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss'), errText: '' } as PendingReq
              }
            })
            this.pendingReqList.set(list)
            this.pendingLoading.set(false)
          },
          error: () => {
            this.toPendingErrTxt.set('unknown error occurred')
            this.pendingLoading.set(false)
          },
        })
      },
      error: (err) => {
        this.toPendingErrTxt.set('unknown error occurred')
        this.pendingLoading.set(false)
      },
    })

    this.userService.queryFromPending({ take: 20, beforeDate: new Date().getTime() }).subscribe({
      next: (res) => {
        if (res.code !== 0) {
          this.sentErrTxt.set('unknown error occurred')
          this.sentLoading.set(false)
          return
        }
        const userIds = res.data!.map(item => item.peerUserId)
        this.userService.queryUserInfo({ userIds }).subscribe({
          next: (res2) => {
            if (res2.code !== 0) {
              this.sentErrTxt.set('unknown error occurred')
              this.sentLoading.set(false)
              return
            }
            const dict = arrayToDictIndex(res2.data!, 'id')
            const list = res.data!.map(item => {
              const userData = dict[item.peerUserId]
              if (userData) {
                return { ...userData, status: 0, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss'), errText: '' }
              } else {
                return { id: item.peerUserId, uniqName: 'Unknown user', status: -1, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss'), errText: '' } as PendingReq
              }
            })
            this.sentReqList.set(list)
            this.sentLoading.set(false)
          },
          error: () => {
            this.sentErrTxt.set('unknown error occurred')
            this.sentLoading.set(false)
          },
        })
      },
      error: (err) => {
        this.sentErrTxt.set('unknown error occurred')
        this.sentLoading.set(false)
      },
    })

    // 用户打开面板即视为已查看 → 清除好友请求未读角标（后端回写 hasUrFriendReq=false，再刷新本地 profile）。
    this.userService.markFriendReqRead().subscribe(() => this.userService.updateSessionProfile())
  }
}
