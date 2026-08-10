import { Component, input, signal, OnDestroy } from '@angular/core';
import { Subject, Subscription } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FormsModule } from '@angular/forms';
import { UserService, User } from '../../services/user.service';
import {
  displayUserAccount,
  displayUserName,
  Invite,
} from '../../services/model';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { FederatedBadgeComponent } from '../federated-badge/federated-badge.component';
import { translateBizResult } from '../../services/biz-code';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';
import dayjs from 'dayjs';
import { FriendInviteDialogComponent } from '../friend-invite-dialog/friend-invite-dialog.component';

export enum AddTabStatus {
  INIT,
  EMPTY,
  SEARCHING,
  SUCCESS,
  ERROR,
}
// A pending invite row in the Pending / Sent tabs. `id` is the invite's BigInt id (string) — the
// accept/reject/revoke payload. The peer profile (name/avatar/domain/…) is embedded on the invite
// (fromUser for incoming, toUser for outgoing), so no separate profile lookup is needed.
type PendingReq = {
  id: string;
  /** The peer user's numeric id — the avatar cache identity (the invite `id` is NOT a user id). */
  peerId?: number;
  name?: string;
  avatar?: string;
  account?: string;
  isForeigner?: boolean;
  domain?: string;
  reqMessage?: string;
  status: number; // 0 pending, 1 accepted (optimistic "added"), -1 invalid
  date: number;
  errText: string;
};
type RelationshipState =
  | 'NONE'
  | 'OUTGOING_PENDING'
  | 'INCOMING_PENDING'
  | 'FRIEND';

@Component({
  selector: 'app-friend-requests',
  imports: [
    UserAvatarComponent,
    FormsModule,
    MatButtonModule,
    IconComponent,
    FitDialogDirective,
    TranslocoPipe,
    FederatedBadgeComponent,
    FriendInviteDialogComponent,
  ],
  templateUrl: './friend-requests.component.html',
  styleUrl: './friend-requests.component.scss',
})
export class FriendRequestsComponent implements OnDestroy {
  readonly fitOpts = {
    minHeight: 560,
  } as const;
  readonly searchText = signal('');
  /** When set, the in-flight federated resolve is a FIRST-CONTACT handshake with this peer domain. The
   *  server's peer-trust-status pre-check reported the domain untrusted (no FederatedPeer 'trusted'
   *  row), so the resolve WILL run the init handshake (up to the S2S call timeout) — show a small
   *  "Connecting to <domain>…" banner with a Cancel button so the UI never appears frozen. Cleared the
   *  instant the resolve settles. An already-trusted domain never sets this: its resolve is fast and
   *  stays on the plain "Searching…" hint. This is a known server-side fact, not a latency guess. */
  readonly connectingDomain = signal<string | null>(null);
  private trustSub: Subscription | undefined;
  private searchSub: Subscription | undefined;
  /** Exact account resolution always yields zero or one row. */
  readonly localResults = signal<User[]>([]);
  readonly inviteUser = signal<User | null>(null);
  readonly errMsg = signal('');
  readonly addTabStatus = signal<AddTabStatus>(AddTabStatus.INIT);
  readonly relationshipStates = signal<ReadonlyMap<number, RelationshipState>>(
    new Map(),
  );
  readonly curSearchText = signal('');
  readonly pendingReqList = signal([] as PendingReq[]);
  readonly toPendingErrTxt = signal('');
  readonly pendingLoading = signal(true);
  readonly sentReqList = signal([] as PendingReq[]);
  readonly sentErrTxt = signal('');
  readonly sentLoading = signal(true);

  subject = input<Subject<any> | undefined>(undefined);
  initialTab = input<'add' | 'pending'>('add');
  activeTab = signal(0);
  isShowBackBtn = signal(true);

  UserAvatarType = UserAvatarType;
  AddTabStatus = AddTabStatus;
  AppIconType = AppIconType;
  displayUserName = displayUserName;
  displayUserAccount = displayUserAccount;

  constructor(
    private routeService: RouteService,
    private userService: UserService,
    private transloco: TranslocoService,
    private snackBar: MatSnackBar,
  ) {}
  setTab(tab: number) {
    this.activeTab.set(tab);
    this.loadTab(tab);
    if (tab === 1) this.userService.markFriendReqRead();
  }

  goBack() {
    if (this.inviteUser()) {
      this.inviteUser.set(null);
      return;
    }
    this.routeService.closeDlg();
  }

  searchUser() {
    const curSearchText = this.searchText().trim();
    if (!curSearchText) return;
    this.addTabStatus.set(AddTabStatus.SEARCHING);
    this.cancelInFlight();
    this.localResults.set([]);

    // All friend search is exact. A local account resolves by account alone; a federated address resolves
    // by account + domain. This deliberately never calls fuzzy user discovery, so the UI can show at most
    // one result and cannot be used to enumerate accounts or display names.
    // The `@` is a UI input aid ONLY — split the typed `account@domain` into two fields here, at the
    // input boundary, so the API never carries an @-joined string. A bare account (no `@`) is a local
    // lookup (domain omitted).
    const at = curSearchText.lastIndexOf('@');
    const firstAt = curSearchText.indexOf('@');
    if (
      firstAt !== -1 &&
      (at <= 0 || at === curSearchText.length - 1 || firstAt !== at)
    ) {
      this.curSearchText.set(curSearchText);
      this.addTabStatus.set(AddTabStatus.EMPTY);
      return;
    }
    const domain =
      at > 0 && at < curSearchText.length - 1
        ? curSearchText.slice(at + 1)
        : null;
    const account = at > 0 ? curSearchText.slice(0, at) : curSearchText;

    // Exact resolve → establish trust when federated (if needed) → fetch profile → one card.
    const runResolve = () => {
      this.searchSub = this.userService
        .resolveUser({ account, ...(domain ? { domain } : {}) })
        .subscribe({
          next: (res) => {
            this.connectingDomain.set(null);
            if (res.code === 0) {
              this.applySelectedUser(res.data!);
            } else {
              this.curSearchText.set(curSearchText);
              this.addTabStatus.set(AddTabStatus.EMPTY);
            }
          },
          error: () => {
            this.connectingDomain.set(null);
            this.errMsg.set(
              this.transloco.translate('friend.error.unknownError'),
            );
            this.addTabStatus.set(AddTabStatus.ERROR);
          },
        });
    };

    if (domain) {
      // A federated address MAY need the init handshake. Whether it does is a known server-side fact
      // (a FederatedPeer 'trusted' row), NOT a latency guess — ask first (peer-trust-status, a cheap
      // local lookup). Only an untrusted domain means a first-contact handshake will run during the
      // resolve, so only then surface the "Connecting to <domain>…" banner. An already-trusted domain
      // resolves fast and stays on the plain "Searching…" hint.
      this.trustSub = this.userService.peerTrustStatus({ domain }).subscribe({
        next: (res) => {
          if (res.code === 0 && !res.data!.trusted) {
            this.connectingDomain.set(domain);
          }
          runResolve();
        },
        error: () => {
          // Pre-flight itself failed (rare) — fall through to the resolve, which surfaces its own error.
          runResolve();
        },
      });
    } else {
      runResolve();
    }
  }

  /** A single exact account has been resolved: check the P2P relationship
   *  state to decide can-add / already-friends / request-already-sent / they-sent-you-one, then show
   *  the single-user card. Shared by both search paths so the post-select UX is identical. */
  private applySelectedUser(user: User) {
    if (user.id === this.userService.sessionProfile()!.id) {
      this.curSearchText.set(this.searchText().trim());
      this.addTabStatus.set(AddTabStatus.EMPTY);
      return;
    }
    this.showResults([user]);
  }

  private showResults(users: User[]) {
    this.userService
      .friendRelationshipStatuses({ userIds: users.map((user) => user.id) })
      .subscribe({
        next: (res) => {
          if (res.code !== 0 || !res.data) {
            this.errMsg.set(translateBizResult(res, this.transloco));
            this.addTabStatus.set(AddTabStatus.ERROR);
            return;
          }
          this.relationshipStates.set(
            new Map(res.data.map((item) => [item.userId, item.status])),
          );
          this.localResults.set(users);
          this.addTabStatus.set(AddTabStatus.SUCCESS);
        },
        error: () => {
          this.errMsg.set(
            this.transloco.translate('friend.error.unknownError'),
          );
          this.addTabStatus.set(AddTabStatus.ERROR);
        },
      });
  }

  activateResult(user: User) {
    const status = this.relationshipStates().get(user.id) ?? 'NONE';
    if (status === 'INCOMING_PENDING') {
      this.setTab(1);
      return;
    }
    if (status === 'NONE') this.openInviteDialog(user);
  }

  openInviteDialog(user: User) {
    this.inviteUser.set(user);
  }

  completeInvite(result: {
    userId: number;
    status: 'OUTGOING_PENDING' | 'FRIEND';
  }) {
    this.relationshipStates.update((states) =>
      new Map(states).set(result.userId, result.status),
    );
    this.inviteUser.set(null);
  }

  relationshipLabel(userId: number): string {
    switch (this.relationshipStates().get(userId)) {
      case 'OUTGOING_PENDING':
        return 'friend.sentStatus';
      case 'INCOMING_PENDING':
        return 'friend.reviewRequest';
      case 'FRIEND':
        return 'friend.friendStatus';
      default:
        return 'friend.addAction';
    }
  }

  /** Abort any in-flight trust pre-check or resolve and drop the connecting banner. The init handshake
   *  is idempotent, so a partial/aborted one is safe to re-run on the next search. */
  private cancelInFlight() {
    this.trustSub?.unsubscribe();
    this.trustSub = undefined;
    this.searchSub?.unsubscribe();
    this.searchSub = undefined;
    this.connectingDomain.set(null);
  }

  /** Cancel button: abort the in-flight search and reset the Add tab to its initial state. */
  cancelSearch() {
    this.cancelInFlight();
    this.addTabStatus.set(AddTabStatus.INIT);
    this.searchText.set('');
    this.localResults.set([]);
  }

  ngOnDestroy() {
    this.cancelInFlight();
  }

  approve(index: number) {
    const req = this.pendingReqList()[index];
    this.userService.acceptInvite({ inviteId: req.id }).subscribe((res) => {
      const reqList = this.pendingReqList();
      if (res.code === 0) {
        // Optimistic "added": keep the row showing "Added" (status 1). Not persisted — next panel open
        // re-queries and the backend filters out the now-friend, so it disappears on its own.
        this.pendingReqList.set(
          reqList
            .slice(0, index)
            .concat([{ ...req, status: 1, errText: '' }])
            .concat(reqList.slice(index + 1)),
        );
      } else {
        this.pendingReqList.set(
          reqList
            .slice(0, index)
            .concat([
              {
                ...req,
                status: 0,
                errText: translateBizResult(res, this.transloco),
              },
            ])
            .concat(reqList.slice(index + 1)),
        );
      }
    });
  }

  decline(index: number) {
    const req = this.pendingReqList()[index];
    this.userService.rejectInvite({ inviteId: req.id }).subscribe((res) => {
      if (res.code === 0) {
        // Rejected: remove from the pending list (filter by id to avoid index drift).
        this.pendingReqList.set(
          this.pendingReqList().filter((r) => r.id !== req.id),
        );
        this.snackBar.open(
          this.transloco.translate('friend.declinedToast'),
          undefined,
          { duration: 3000 },
        );
      } else {
        // Failed: keep it and tag the error copy (errText always renders in the template).
        this.pendingReqList.set(
          this.pendingReqList().map((r) =>
            r.id === req.id
              ? { ...r, errText: translateBizResult(res, this.transloco) }
              : r,
          ),
        );
      }
    });
  }

  cancelSent(index: number) {
    const req = this.sentReqList()[index];
    this.userService.revokeInvite({ inviteId: req.id }).subscribe((res) => {
      if (res.code === 0) {
        // Revoked: remove from the sent list (filter by id to avoid index drift).
        this.sentReqList.set(this.sentReqList().filter((r) => r.id !== req.id));
        this.snackBar.open(
          this.transloco.translate('friend.revokedToast'),
          undefined,
          { duration: 3000 },
        );
      } else {
        // Failed: keep it and tag the error copy.
        this.sentReqList.set(
          this.sentReqList().map((r) =>
            r.id === req.id
              ? { ...r, errText: translateBizResult(res, this.transloco) }
              : r,
          ),
        );
      }
    });
  }

  /** Incoming invite → pending-row (the peer is the inviter, fromUser). */
  private inviteToPending(inv: Invite): PendingReq {
    return this.toPendingReq(inv, inv.fromUser);
  }

  /** Outgoing invite → sent-row (the peer is the recipient, toUser). */
  private inviteToSent(inv: Invite): PendingReq {
    return this.toPendingReq(inv, inv.toUser);
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
      date: inv.createdAt,
      errText: '',
    };
  }

  relativeDate(timestamp: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return this.transloco.translate('friend.time.justNow');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
      return this.transloco.translate('friend.time.minutes', {
        count: minutes,
      });
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
      return this.transloco.translate('friend.time.hours', { count: hours });
    const days = Math.floor(hours / 24);
    if (days < 7)
      return this.transloco.translate('friend.time.days', { count: days });
    return dayjs(timestamp).format('YYYY-MM-DD');
  }

  absoluteDate(timestamp: number): string {
    return dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss');
  }

  private loadTab(tab: number) {
    if (tab === 1) this.loadIncomingInvites();
    if (tab === 2) this.loadOutgoingInvites();
  }

  private loadIncomingInvites() {
    // Clear the previous snapshot before refreshing so stale requests never remain visible while the
    // newly displayed tab is loading.
    this.pendingReqList.set([]);
    this.toPendingErrTxt.set('');
    this.pendingLoading.set(true);

    // Parameterless: backend hardcodes last-7-days / ≤200 / FRIEND / PENDING, and filters out peers
    // who are already friends. The inviter profile is embedded (fromUser), so no queryUserInfo round-trip.
    this.userService.listIncomingInvites().subscribe({
      next: (res) => {
        if (res.code !== 0) {
          this.toPendingErrTxt.set(
            this.transloco.translate('friend.error.unknownError'),
          );
        } else {
          this.pendingReqList.set(
            res.data!.map((inv) => this.inviteToPending(inv)),
          );
        }
        this.pendingLoading.set(false);
      },
      error: () => {
        this.toPendingErrTxt.set(
          this.transloco.translate('friend.error.unknownError'),
        );
        this.pendingLoading.set(false);
      },
    });
  }

  private loadOutgoingInvites() {
    this.sentReqList.set([]);
    this.sentErrTxt.set('');
    this.sentLoading.set(true);

    this.userService.listOutgoingInvites().subscribe({
      next: (res) => {
        if (res.code !== 0) {
          this.sentErrTxt.set(
            this.transloco.translate('friend.error.unknownError'),
          );
        } else {
          this.sentReqList.set(res.data!.map((inv) => this.inviteToSent(inv)));
        }
        this.sentLoading.set(false);
      },
      error: () => {
        this.sentErrTxt.set(
          this.transloco.translate('friend.error.unknownError'),
        );
        this.sentLoading.set(false);
      },
    });
  }

  ngOnInit() {
    const initialTab = this.initialTab() === 'pending' ? 1 : 0;
    this.activeTab.set(initialTab);
    this.loadTab(initialTab);
    if (initialTab === 1) this.userService.markFriendReqRead();
  }
}
