import { Component, input, signal, OnDestroy } from '@angular/core';
import { Subject, Subscription } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FormsModule } from '@angular/forms';
import { UserService, User } from '../../services/user.service';
import { displayUserName } from '../../services/model';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { FederatedBadgeComponent } from '../federated-badge/federated-badge.component';
import { MsgService } from '../../services/message.service'
import { translateBizResult } from '../../services/biz-code'
import { arrayToDictIndex } from '../../../utils';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';
import dayjs from 'dayjs';

enum AddTabStatus {
  INIT, EMPTY, SEARCHING, SUCCESS, ERROR
}
// The underlying User data is optional: the degraded "Unknown user" fallback row
// (built when a pending/sent request's user can't be resolved) lacks name/avatar/bio,
// so the avatar falls back to the initial letter. Resolved rows spread a full User.
type PendingReq = Omit<User, 'name' | 'avatar' | 'bio'>
  & Partial<Pick<User, 'name' | 'avatar' | 'bio'>>
  & { status: number, date: string, errText: string, reqMessage?: string }

@Component({
    selector: 'app-friend-requests',
    imports: [UserAvatarComponent, FormsModule,
        MatButtonModule, IconComponent, FitDialogDirective, TranslocoPipe, FederatedBadgeComponent],
    templateUrl: './friend-requests.component.html',
    styleUrl: './friend-requests.component.scss'
})
export class FriendRequestsComponent implements OnDestroy {
  readonly fitOpts = { minHeight: 420 } as const
  readonly searchText = signal('')
  readonly friendReqMessage = signal('')
  /** When set, the in-flight federated resolve is a FIRST-CONTACT handshake with this peer domain. The
   *  server's peer-trust-status pre-check reported the domain untrusted (no FederatedPeer 'trusted'
   *  row), so the resolve WILL run the init handshake (up to the S2S call timeout) — show a small
   *  "Connecting to <domain>…" banner with a Cancel button so the UI never appears frozen. Cleared the
   *  instant the resolve settles. An already-trusted domain never sets this: its resolve is fast and
   *  stays on the plain "Searching…" hint. This is a known server-side fact, not a latency guess. */
  readonly connectingDomain = signal<string | null>(null)
  private trustSub: Subscription | undefined
  private searchSub: Subscription | undefined
  readonly userData = signal<User | undefined>(undefined)
  /** Local fuzzy discovery results (Add tab). When non-empty, the Add tab renders this list instead of
   *  the single resolved-user card. Cleared when a result is picked (→ single card) or on a new search. */
  readonly localResults = signal<User[]>([])
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
  displayUserName = displayUserName

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
    this.cancelInFlight()
    this.localResults.set([])

    // Branch on shape: a federated address (username@domain) resolves EXACTLY (you can't enumerate a
    // remote user table — only resolve a known handle via S2S); anything else is LOCAL fuzzy discovery
    // (POST /user/search, matches uniqName OR display name). The first-contact handshake banner only
    // applies to the federated path.
    // The `@` is a UI input aid ONLY — split the typed `username@domain` into two fields here, at the
    // input boundary, so the API never carries an @-joined string. A bare username (no `@`) is a local
    // lookup (domain omitted).
    const at = curSearchText.lastIndexOf('@')
    const domain = at > 0 && at < curSearchText.length - 1 ? curSearchText.slice(at + 1) : null
    const username = at > 0 ? curSearchText.slice(0, at) : curSearchText

    // Federated: exact resolve → establish trust (if needed) → fetch peer profile → single card.
    const runResolve = () => {
      this.searchSub = this.userService.resolveUser({ username, ...(domain ? { domain } : {}) }).subscribe({
        next: res => {
          this.connectingDomain.set(null)
          if (res.code === 0) {
            this.applySelectedUser(res.data!)
          } else {
            this.curSearchText.set(curSearchText)
            this.addTabStatus.set(AddTabStatus.EMPTY)
          }
        }, error: () => {
          this.connectingDomain.set(null)
          this.errMsg.set(this.transloco.translate('friend.error.unknownError'))
          this.addTabStatus.set(AddTabStatus.ERROR)
        }
      })
    }

    // Local: fuzzy discovery → result list (each row picks → single card via applySelectedUser).
    const runLocalSearch = () => {
      this.searchSub = this.userService.searchUsers({ q: curSearchText }).subscribe({
        next: res => {
          if (res.code === 0 && res.data) {
            const myId = this.userService.sessionProfile()!.id
            const list = res.data.list.filter((u) => u.id !== myId)
            if (list.length > 0) {
              this.localResults.set(list)
              this.addTabStatus.set(AddTabStatus.SUCCESS)
            } else {
              this.curSearchText.set(curSearchText)
              this.addTabStatus.set(AddTabStatus.EMPTY)
            }
          } else {
            this.curSearchText.set(curSearchText)
            this.addTabStatus.set(AddTabStatus.EMPTY)
          }
        },
        error: () => {
          this.errMsg.set(this.transloco.translate('friend.error.unknownError'))
          this.addTabStatus.set(AddTabStatus.ERROR)
        },
      })
    }

    if (domain) {
      // A federated address MAY need the init handshake. Whether it does is a known server-side fact
      // (a FederatedPeer 'trusted' row), NOT a latency guess — ask first (peer-trust-status, a cheap
      // local lookup). Only an untrusted domain means a first-contact handshake will run during the
      // resolve, so only then surface the "Connecting to <domain>…" banner. An already-trusted domain
      // resolves fast and stays on the plain "Searching…" hint.
      this.trustSub = this.userService.peerTrustStatus({ domain }).subscribe({
        next: res => {
          if (res.code === 0 && !res.data!.trusted) {
            this.connectingDomain.set(domain)
          }
          runResolve()
        },
        error: () => {
          // Pre-flight itself failed (rare) — fall through to the resolve, which surfaces its own error.
          runResolve()
        },
      })
    } else {
      runLocalSearch()
    }
  }

  /** A single user has been resolved (federated) or picked (local list): check the P2P relationship
   *  state to decide can-add / already-friends / request-already-sent / they-sent-you-one, then show
   *  the single-user card. Shared by both search paths so the post-select UX is identical. */
  private applySelectedUser(user: User) {
    if (user.id === this.userService.sessionProfile()!.id) {
      this.userData.set(user)
      this.addTabStatus.set(AddTabStatus.SUCCESS)
      this.canAdd.set(false)
      this.reqRspTxt.set(this.transloco.translate('friend.error.canNotAddSelf'))
      return
    }
    // First query the P2P thread status with this user to decide which state applies
    // (can add / already friends / request already sent / they sent one to you), instead of
    // always showing Send Request (avoids re-inviting an existing friend and misleading copy).
    this.msgService.getThreadByUserId({ userId: user.id }).subscribe(res2 => {
      this.userData.set(user)
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

  /** A local discovery result was clicked: drop the list and show that user's single card. */
  pickLocalUser(user: User) {
    this.localResults.set([])
    this.applySelectedUser(user)
  }

  /** Abort any in-flight trust pre-check or resolve and drop the connecting banner. The init handshake
   *  is idempotent, so a partial/aborted one is safe to re-run on the next search. */
  private cancelInFlight() {
    this.trustSub?.unsubscribe()
    this.trustSub = undefined
    this.searchSub?.unsubscribe()
    this.searchSub = undefined
    this.connectingDomain.set(null)
  }

  /** Cancel button: abort the in-flight search and reset the Add tab to its initial state. */
  cancelSearch() {
    this.cancelInFlight()
    this.addTabStatus.set(AddTabStatus.INIT)
    this.searchText.set('')
    this.localResults.set([])
  }

  ngOnDestroy() {
    this.cancelInFlight()
  }

  sendRequest() {
    this.reqRspTxt.set('')
    const message = this.friendReqMessage().trim().slice(0, 255)
    this.userService.sendFriendRequest({ userId: this.userData()!.id, message }).subscribe({
      next: res => {
        // Echo the backend message directly: the backend already returns status-keyed copy
        // ("friend request sent" / "you are already friends" / "you are now friends"), so the
        // client does not hardcode a "sent successfully" string.
        this.reqRspTxt.set(translateBizResult(res, this.transloco))
        this.friendReqMessage.set('')
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
                return { ...userData, reqMessage: item.reqMessage, status: 0, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss'), errText: '' }
              } else {
                return { id: item.peerUserId, uniqName: '', name: this.transloco.translate('common.unknownUser'), reqMessage: item.reqMessage, status: -1, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss'), errText: '' } as PendingReq
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
                return { ...userData, reqMessage: item.reqMessage, status: 0, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss'), errText: '' }
              } else {
                return { id: item.peerUserId, uniqName: '', name: this.transloco.translate('common.unknownUser'), reqMessage: item.reqMessage, status: -1, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss'), errText: '' } as PendingReq
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
