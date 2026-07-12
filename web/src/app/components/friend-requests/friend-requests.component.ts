import { Component, input, signal, OnDestroy } from '@angular/core';
import { Subject, Subscription } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FormsModule } from '@angular/forms';
import { UserService, User } from '../../services/user.service';
import { displayUserName, Invite } from '../../services/model';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { FederatedBadgeComponent } from '../federated-badge/federated-badge.component';
import { MsgService } from '../../services/message.service'
import { translateBizResult } from '../../services/biz-code'
import { FitDialogDirective } from '../../directives/fit-dialog.directive';
import dayjs from 'dayjs';

enum AddTabStatus {
  INIT, EMPTY, SEARCHING, SUCCESS, ERROR
}
// A pending invite row in the Pending / Sent tabs. `id` is the invite's BigInt id (string) — the
// accept/reject/revoke payload. The peer profile (name/avatar/domain/…) is embedded on the invite
// (fromUser for incoming, toUser for outgoing), so no separate profile lookup is needed.
type PendingReq = {
  id: string
  /** The peer user's numeric id — the avatar cache identity (the invite `id` is NOT a user id). */
  peerId?: number
  name?: string
  avatar?: string
  account?: string
  isForeigner?: boolean
  domain?: string
  reqMessage?: string
  status: number  // 0 pending, 1 accepted (optimistic "added"), -1 invalid
  date: string
  errText: string
}

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

    // Branch on shape: a federated address (account@domain) resolves EXACTLY (you can't enumerate a
    // remote user table — only resolve a known handle via S2S); anything else is LOCAL fuzzy discovery
    // (POST /user/search, matches account OR display name). The first-contact handshake banner only
    // applies to the federated path.
    // The `@` is a UI input aid ONLY — split the typed `account@domain` into two fields here, at the
    // input boundary, so the API never carries an @-joined string. A bare account (no `@`) is a local
    // lookup (domain omitted).
    const at = curSearchText.lastIndexOf('@')
    const domain = at > 0 && at < curSearchText.length - 1 ? curSearchText.slice(at + 1) : null
    const account = at > 0 ? curSearchText.slice(0, at) : curSearchText

    // Federated: exact resolve → establish trust (if needed) → fetch peer profile → single card.
    const runResolve = () => {
      this.searchSub = this.userService.resolveUser({ account, ...(domain ? { domain } : {}) }).subscribe({
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
    // A friend relationship == a shared P2P thread. getThreadByUserId returns it (code 0) when friends,
    // THREAD_NOT_FOUND (30003) otherwise. The pending-direction hints are gone (the invite model
    // overwrites a re-invite, so re-sending is idempotent) — friends → already-friends; else → can invite.
    this.msgService.getThreadByUserId({ userId: user.id }).subscribe(res2 => {
      this.userData.set(user)
      this.addTabStatus.set(AddTabStatus.SUCCESS)
      if (res2.code === 0) {
        this.canAdd.set(false)
        this.reqRspTxt.set(this.transloco.translate('friend.error.alreadyFriends'))
      } else {
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
    const note = this.friendReqMessage().trim().slice(0, 255)
    this.userService.sendFriendInvite({ toUserId: this.userData()!.id, note }).subscribe({
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
    this.userService.acceptInvite({ inviteId: req.id }).subscribe(res => {
      const reqList = this.pendingReqList()
      if (res.code === 0) {
        // Optimistic "added": keep the row showing 已添加 (status 1). Not persisted — next panel open
        // re-queries and the backend filters out the now-friend, so it disappears on its own.
        this.pendingReqList.set(reqList.slice(0, index).concat([{ ...req, status: 1, errText: '' }]).concat(reqList.slice(index + 1)))
      } else {
        this.pendingReqList.set(reqList.slice(0, index).concat([{ ...req, status: 0, errText: translateBizResult(res, this.transloco) }]).concat(reqList.slice(index + 1)))
      }
    })

  }

  decline(index: number) {
    const req = this.pendingReqList()[index]
    this.userService.rejectInvite({ inviteId: req.id }).subscribe(res => {
      if (res.code === 0) {
        // Rejected: remove from the pending list (filter by id to avoid index drift).
        this.pendingReqList.set(this.pendingReqList().filter(r => r.id !== req.id))
      } else {
        // Failed: keep it and tag the error copy (errText always renders in the template).
        this.pendingReqList.set(this.pendingReqList().map(r => r.id === req.id ? { ...r, errText: translateBizResult(res, this.transloco) } : r))
      }
    })
  }

  cancelSent(index: number) {
    const req = this.sentReqList()[index]
    this.userService.revokeInvite({ inviteId: req.id }).subscribe(res => {
      if (res.code === 0) {
        // Revoked: remove from the sent list (filter by id to avoid index drift).
        this.sentReqList.set(this.sentReqList().filter(r => r.id !== req.id))
      } else {
        // Failed: keep it and tag the error copy.
        this.sentReqList.set(this.sentReqList().map(r => r.id === req.id ? { ...r, errText: translateBizResult(res, this.transloco) } : r))
      }
    })
  }

  /** Incoming invite → pending-row (the peer is the inviter, fromUser). */
  private inviteToPending(inv: Invite): PendingReq {
    return this.toPendingReq(inv, inv.fromUser)
  }

  /** Outgoing invite → sent-row (the peer is the recipient, toUser). */
  private inviteToSent(inv: Invite): PendingReq {
    return this.toPendingReq(inv, inv.toUser)
  }

  private toPendingReq(inv: Invite, peer: Invite['fromUser']): PendingReq {
    return {
      id: inv.id,
      peerId: peer.id,
      name: peer.name,
      avatar: peer.avatar,
      account: peer.account,
      isForeigner: peer.isForeigner,
      domain: peer.domain,
      reqMessage: inv.note,
      status: 0,
      date: dayjs(inv.createdAt).format('YYYY-MM-DD HH:mm:ss'),
      errText: '',
    }
  }

  ngOnInit() {
    // Parameterless: backend hardcodes last-7-days / ≤200 / FRIEND / PENDING, and filters out peers
    // who are already friends. The inviter profile is embedded (fromUser), so no queryUserInfo round-trip.
    this.userService.listIncomingInvites().subscribe({
      next: (res) => {
        if (res.code !== 0) {
          this.toPendingErrTxt.set(this.transloco.translate('friend.error.unknownError'))
        } else {
          this.pendingReqList.set(res.data!.map(inv => this.inviteToPending(inv)))
        }
        this.pendingLoading.set(false)
      },
      error: () => {
        this.toPendingErrTxt.set(this.transloco.translate('friend.error.unknownError'))
        this.pendingLoading.set(false)
      },
    })

    this.userService.listOutgoingInvites().subscribe({
      next: (res) => {
        if (res.code !== 0) {
          this.sentErrTxt.set(this.transloco.translate('friend.error.unknownError'))
        } else {
          this.sentReqList.set(res.data!.map(inv => this.inviteToSent(inv)))
        }
        this.sentLoading.set(false)
      },
      error: () => {
        this.sentErrTxt.set(this.transloco.translate('friend.error.unknownError'))
        this.sentLoading.set(false)
      },
    })

    // Opening the panel counts as "seen" → clear the friend-invite unread badge (hasUrFriendReq=false,
    // then refresh the local profile).
    this.userService.markInvitesRead().subscribe(() => this.userService.updateSessionProfile())
  }
}
