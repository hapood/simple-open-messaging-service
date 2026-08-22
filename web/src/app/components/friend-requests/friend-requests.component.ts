import {
  Component,
  computed,
  effect,
  input,
  signal,
  untracked,
  OnDestroy,
  ChangeDetectionStrategy,
} from '@angular/core';
import { Observable, Subject, Subscription, finalize } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { PageHeaderComponent } from '../page-header/page-header.component';
import { FormsModule } from '@angular/forms';
import {
  FederatedResolveStage,
  FederatedResolveError,
  UserService,
  User,
} from '../../services/user.service';
import { displayUserName, Invite } from '../../services/model';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { translateBizResult } from '../../services/biz-code';
import dayjs from 'dayjs';
import { FriendInviteDialogComponent } from '../friend-invite-dialog/friend-invite-dialog.component';
import { VirtualInfiniteListComponent } from '../virtual-infinite-list/virtual-infinite-list.component';
import {
  FriendRequestCardComponent,
  FriendRequestCardModel,
} from '../friend-request-card/friend-request-card.component';
import { UserIdentityLabelComponent } from '../user-identity-label/user-identity-label.component';

export enum AddTabStatus {
  INIT,
  EMPTY,
  SEARCHING,
  SUCCESS,
  ERROR,
}
const FEDERATED_RESOLVE_STAGES: readonly FederatedResolveStage[] = [
  'DISCOVERING',
  'VERIFYING_IDENTITY',
  'CONNECTING',
  'WAITING_FOR_PEER',
  'FETCHING_USER',
];
// A pending invite row in the Pending / Sent tabs. `id` is the invite's BigInt id (string) — the
// accept/revoke payload. The peer profile (name/avatar/domain/…) is embedded on the invite
// (fromUser for incoming, toUser for outgoing), so no separate profile lookup is needed.
type PendingReq = {
  id: string;
  /** Existing stub id, or an Address key while no stub exists. */
  peerId?: number | string;
  name?: string;
  avatar?: string;
  account?: string;
  isForeigner?: boolean;
  domain?: string;
  reqMessage?: string;
  status: number; // 0 pending, 1 accepted, -1 invalid, -2 expired, -3 revoked
  date: number;
  errText: string;
  kind?: 'FRIEND' | 'GROUP';
  sourceLabel?: string;
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
    MatProgressBarModule,
    MatTabsModule,
    IconComponent,
    PageHeaderComponent,
    TranslocoPipe,
    FriendInviteDialogComponent,
    VirtualInfiniteListComponent,
    FriendRequestCardComponent,
    UserIdentityLabelComponent,
  ],
  templateUrl: './friend-requests.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './friend-requests.component.scss',
})
export class FriendRequestsComponent implements OnDestroy {
  readonly searchText = signal('');
  /** When set, the in-flight federated resolve is a FIRST-CONTACT handshake with this peer domain. The
   *  server's peer-trust-status pre-check reported the domain untrusted (no FederatedPeer 'trusted'
   *  row), so the resolve WILL run the init handshake (up to the S2S call timeout) — show a small
   *  "Connecting to <domain>…" banner with a Cancel button so the UI never appears frozen. Cleared the
   *  instant the resolve settles. An already-trusted domain never sets this: its resolve is fast and
   *  stays on the plain "Searching…" hint. This is a known server-side fact, not a latency guess. */
  readonly connectingDomain = signal<string | null>(null);
  readonly federationStage = signal<FederatedResolveStage>('DISCOVERING');
  readonly federationStageKey = computed(
    () => `friend.federationStage.${this.federationStage()}`,
  );
  readonly federationProgress = computed(() => {
    const index = FEDERATED_RESOLVE_STAGES.indexOf(this.federationStage());
    const current = index < 0 ? 1 : index + 1;
    return {
      current,
      total: FEDERATED_RESOLVE_STAGES.length,
      percent: (current / FEDERATED_RESOLVE_STAGES.length) * 100,
    };
  });
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
  readonly selectedRequest = signal<FriendRequestCardModel | null>(null);
  readonly selectedDirection = signal<'INCOMING' | 'OUTGOING'>('INCOMING');
  readonly pendingCount = signal(0);
  readonly sentCount = signal(0);
  readonly pendingHasMore = signal(false);
  readonly sentHasMore = signal(false);
  readonly hasUnreadIncoming = computed(() =>
    this.userService.friendReqBadge(),
  );
  private pendingCursor: string | null = null;
  private sentCursor: string | null = null;
  /** Invalidates an older list request when a newer reset starts. State-feed revisions can arrive in
   *  quick succession, so more than one reset may be in flight at once. */
  private pendingLoadGeneration = 0;
  private sentLoadGeneration = 0;
  private observedRequestRevision: number | undefined;
  private inviteListsInitialized = false;
  readonly pendingInviteActionIds = signal<ReadonlySet<string>>(new Set());
  private readonly inviteActionSubscriptions = new Map<
    string,
    { subscription?: Subscription }
  >();

  subject = input<Subject<any> | undefined>(undefined);
  initialTab = input<'add' | 'pending'>('add');
  /** Optional profile-card shortcut. Local targets can open the shared invite step immediately;
   * federated targets first run the normal exact-address resolve so first-contact handshake progress
   * remains visible and cancellable in this dialog. */
  initialUser = input<User | undefined>(undefined);
  activeTab = signal(0);
  isShowBackBtn = signal(true);

  UserAvatarType = UserAvatarType;
  AddTabStatus = AddTabStatus;
  AppIconType = AppIconType;
  displayUserName = displayUserName;

  openRequest(req: PendingReq, direction: 'INCOMING' | 'OUTGOING'): void {
    this.selectedRequest.set(req);
    this.selectedDirection.set(direction);
  }

  closeRequest(): void {
    this.selectedRequest.set(null);
  }

  deleteSelected(req: FriendRequestCardModel): void {
    if (this.selectedDirection() === 'OUTGOING') this.cancelSent(req);
    this.closeRequest();
  }

  constructor(
    private routeService: RouteService,
    private userService: UserService,
    private transloco: TranslocoService,
    private snackBar: MatSnackBar,
  ) {
    effect(() => {
      const revision = this.userService.friendIntentStateRevision();
      if (
        !this.inviteListsInitialized ||
        this.observedRequestRevision === undefined ||
        revision <= this.observedRequestRevision
      ) {
        return;
      }
      this.observedRequestRevision = revision;
      // A live revision refreshes both counters and lists, regardless of the visible tab. It deliberately
      // does not advance the seen revision: a request arriving while this dialog is open stays unread until
      // the user explicitly visits Incoming again (or opens the dialog there next time).
      untracked(() => {
        void Promise.all([
          this.loadIncomingInvites(true),
          this.loadOutgoingInvites(true),
        ]);
      });
    });
  }
  setTab(tab: number) {
    this.activeTab.set(tab);
    if (tab === 1) this.userService.markFriendReqRead();
  }

  goBack() {
    if (this.selectedRequest()) {
      this.closeRequest();
      return;
    }
    if (this.initialUser()) {
      this.routeService.closeDlg();
      return;
    }
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

    // Local exact resolve remains a normal request. Federated resolve is a temporary SSE proxy and
    // returns a transient id=0 card plus its Address-based relationship state.
    const runResolve = () => {
      this.searchSub = domain
        ? this.userService
            .resolveFederatedUser({ account, domain }, (stage) =>
              this.federationStage.set(stage),
            )
            .subscribe({
              next: ({ user, relationship }) => {
                this.connectingDomain.set(null);
                this.relationshipStates.set(new Map([[user.id, relationship]]));
                this.localResults.set([user]);
                this.addTabStatus.set(AddTabStatus.SUCCESS);
              },
              error: (error: unknown) => {
                this.connectingDomain.set(null);
                const reason =
                  error instanceof FederatedResolveError
                    ? error.reason
                    : 'UNKNOWN';
                const keys: Record<string, string> = {
                  DOMAIN_RESOLUTION_FAILED: 'friend.error.domainResolution',
                  TIMEOUT: 'friend.error.timeout',
                  BLOCKED: 'friend.error.blocked',
                  NOT_FOUND: 'friend.msg.friendNotFound',
                  UNREACHABLE: 'friend.error.unreachable',
                  INVALID_ADDRESS: 'friend.error.invalidAddress',
                };
                this.errMsg.set(
                  this.transloco.translate(
                    keys[reason] ?? 'friend.error.unknownError',
                  ),
                );
                this.addTabStatus.set(AddTabStatus.ERROR);
              },
            })
        : this.userService.resolveUser({ account }).subscribe({
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
            this.federationStage.set('DISCOVERING');
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
    if (this.isSelf(user)) {
      this.relationshipStates.set(new Map());
      this.localResults.set([user]);
      this.addTabStatus.set(AddTabStatus.SUCCESS);
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
    if (this.isSelf(user)) return;
    const status = this.relationshipStates().get(user.id) ?? 'NONE';
    if (status === 'INCOMING_PENDING') {
      this.setTab(1);
      return;
    }
    if (status === 'NONE') this.openInviteDialog(user);
  }

  openInviteDialog(user: User) {
    if (this.isSelf(user)) return;
    this.inviteUser.set(user);
  }

  isSelf(user: Pick<User, 'id'>): boolean {
    return user.id === this.userService.sessionProfile()?.id;
  }

  completeInvite(result: {
    userId: number;
    status: 'OUTGOING_PENDING' | 'FRIEND';
  }) {
    if (this.initialUser()) {
      this.routeService.closeDlg(result);
      return;
    }
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
    this.federationStage.set('DISCOVERING');
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
    this.cancelInviteActions();
  }

  approve(req: PendingReq) {
    if (!this.pendingReqList().some((item) => item.id === req.id)) return;
    this.runInviteAction(
      req,
      () => this.userService.acceptInvite(this.inviteAction(req)),
      (res) => {
        if (res.code === 0) {
          // Optimistic "added": patch the current row by identity. A state-feed refresh may have
          // replaced or reordered the list while the request was in flight, so a captured index is
          // not safe. If the authoritative refresh already removed the row, do not resurrect it.
          this.pendingReqList.update((items) =>
            items.map((item) =>
              item.id === req.id ? { ...item, status: 1, errText: '' } : item,
            ),
          );
          this.pendingCount.update((count) => Math.max(0, count - 1));
          if (this.selectedRequest()?.id === req.id) this.closeRequest();
        } else {
          this.pendingReqList.update((items) =>
            items.map((item) =>
              item.id === req.id
                ? {
                    ...item,
                    status: 0,
                    errText: translateBizResult(res, this.transloco),
                  }
                : item,
            ),
          );
          if (this.selectedRequest()?.id === req.id) this.closeRequest();
        }
      },
    );
  }

  cancelSent(req: PendingReq) {
    this.runInviteAction(
      req,
      () => this.userService.revokeInvite(this.inviteAction(req)),
      (res) => {
        if (res.code === 0) {
          // Keep the tombstone visible so the sent-request history reflects the final state.
          this.sentReqList.update((items) =>
            items.map((item) =>
              item.id === req.id ? { ...item, status: -3, errText: '' } : item,
            ),
          );
          if (this.selectedRequest()?.id === req.id)
            this.selectedRequest.update((item) =>
              item ? { ...item, status: -3, errText: '' } : item,
            );
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
      },
    );
  }

  isInviteActionPending(id: string): boolean {
    return this.pendingInviteActionIds().has(id);
  }

  /** Serialize mutations for one invite. Live list refreshes retain these subscriptions and merge
   * their pending state by invite id; only dialog teardown cancels the underlying requests. */
  private runInviteAction<T>(
    req: PendingReq,
    createRequest: () => Observable<T>,
    applyResult: (result: T) => void,
  ): void {
    if (this.inviteActionSubscriptions.has(req.id)) return;

    const entry: { subscription?: Subscription } = {};
    this.inviteActionSubscriptions.set(req.id, entry);
    this.pendingInviteActionIds.update((ids) => new Set(ids).add(req.id));
    entry.subscription = createRequest()
      .pipe(
        finalize(() => {
          if (this.inviteActionSubscriptions.get(req.id) !== entry) return;
          this.inviteActionSubscriptions.delete(req.id);
          this.pendingInviteActionIds.update((ids) => {
            const next = new Set(ids);
            next.delete(req.id);
            return next;
          });
        }),
      )
      .subscribe({ next: applyResult, error: () => undefined });
  }

  private cancelInviteActions(): void {
    const subscriptions = [...this.inviteActionSubscriptions.values()];
    this.inviteActionSubscriptions.clear();
    this.pendingInviteActionIds.set(new Set());
    for (const entry of subscriptions) entry.subscription?.unsubscribe();
  }

  private inviteAction(
    req: PendingReq,
  ): { inviteId: string } | { account: string; domain: string } {
    if (req.kind === 'GROUP' && req.isForeigner && req.account && req.domain)
      return { account: req.account, domain: req.domain };
    if (req.kind === 'GROUP' && req.account) return { inviteId: req.account };
    return req.isForeigner && req.account && req.domain
      ? { account: req.account, domain: req.domain }
      : { inviteId: req.id };
  }

  /** Incoming invite → pending-row (the peer is the inviter, fromUser). */
  private inviteToPending(inv: Invite): PendingReq {
    return this.toPendingReq(inv, inv.fromUser);
  }

  /** Outgoing invite → sent-row (the peer is the recipient, toUser). */
  private inviteToSent(inv: Invite): PendingReq {
    return this.toPendingReq(inv, inv.toUser);
  }

  private groupInviteToPending(
    inv: import('../../services/user.service').ClientGroupInviteIntent,
  ): PendingReq {
    const local = inv.group.isLocal;
    const expired = inv.expiresAt === null || inv.expiresAt <= Date.now();
    return {
      id: `group:${inv.domain}:${inv.account}`,
      peerId: `pending-group:${inv.domain}\u0000${inv.account}`,
      name:
        inv.group.name || this.transloco.translate('friend.groupInviteExpired'),
      avatar: inv.group.avatar,
      account: inv.group.account,
      domain: inv.group.domain,
      reqMessage: expired
        ? this.transloco.translate('friend.groupInviteExpired')
        : inv.group.description,
      status: expired ? -2 : 0,
      date: inv.requestedAt ?? 0,
      errText: '',
      kind: 'GROUP',
      sourceLabel: local
        ? this.transloco.translate('friend.localGroup')
        : inv.group.domain,
    };
  }

  private toPendingReq(inv: Invite, peer: Invite['fromUser']): PendingReq {
    return {
      id: inv.id,
      peerId: this.userIdentity(peer),
      name: peer.name,
      avatar: peer.avatar,
      account: peer.account,
      isForeigner: peer.isForeigner,
      domain: peer.domain,
      reqMessage: inv.note,
      status:
        inv.status === 'REVOKED'
          ? -3
          : inv.status === 'EXPIRED' || inv.expiresAt <= Date.now()
            ? -2
            : 0,
      date: inv.createdAt,
      errText: '',
    };
  }

  userIdentity(peer: Pick<User, 'id' | 'account' | 'domain'>): number | string {
    return peer.id > 0
      ? peer.id
      : `${peer.domain ?? 'local'}\u0000${peer.account}`;
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

  async loadIncomingInvites(reset = false) {
    if (this.pendingLoading() && !reset) return;
    const generation = reset
      ? ++this.pendingLoadGeneration
      : this.pendingLoadGeneration;
    if (reset) {
      this.pendingCursor = null;
    }
    this.toPendingErrTxt.set('');
    this.pendingLoading.set(true);

    // Parameterless: backend hardcodes last-7-days / ≤200 / FRIEND / PENDING, and filters out peers
    // who are already friends. The inviter profile is embedded (fromUser), so no queryUserInfo round-trip.
    try {
      const page = await this.userService.listLocalFriendInvites(
        'INCOMING',
        this.pendingCursor,
        20,
      );
      if (generation !== this.pendingLoadGeneration) return;
      const groupInvites = reset
        ? await this.userService.listLocalGroupInvites()
        : [];
      const nextItems = [
        ...page.items.map((inv) => this.inviteToPending(inv)),
        ...groupInvites.map((inv) => this.groupInviteToPending(inv)),
      ].sort((a, b) => b.date - a.date);
      this.pendingReqList.update((items) =>
        reset ? nextItems : [...items, ...nextItems],
      );
      this.pendingCursor = page.nextCursor;
      this.pendingHasMore.set(page.hasMore);
      this.pendingCount.set(page.total + groupInvites.length);
    } catch {
      if (generation !== this.pendingLoadGeneration) return;
      this.toPendingErrTxt.set(
        this.transloco.translate('friend.error.unknownError'),
      );
    } finally {
      if (generation === this.pendingLoadGeneration)
        this.pendingLoading.set(false);
    }
  }

  async loadOutgoingInvites(reset = false) {
    if (this.sentLoading() && !reset) return;
    const generation = reset
      ? ++this.sentLoadGeneration
      : this.sentLoadGeneration;
    if (reset) {
      this.sentCursor = null;
    }
    this.sentErrTxt.set('');
    this.sentLoading.set(true);

    try {
      const page = await this.userService.listLocalFriendInvites(
        'OUTGOING',
        this.sentCursor,
        20,
      );
      if (generation !== this.sentLoadGeneration) return;
      const nextItems = page.items.map((inv) => this.inviteToSent(inv));
      this.sentReqList.update((items) =>
        reset ? nextItems : [...items, ...nextItems],
      );
      this.sentCursor = page.nextCursor;
      this.sentHasMore.set(page.hasMore);
      this.sentCount.set(page.total);
    } catch {
      if (generation !== this.sentLoadGeneration) return;
      this.sentErrTxt.set(
        this.transloco.translate('friend.error.unknownError'),
      );
    } finally {
      if (generation === this.sentLoadGeneration) this.sentLoading.set(false);
    }
  }

  ngOnInit() {
    const initialUser = this.initialUser();
    if (initialUser) {
      this.activeTab.set(0);
      if (initialUser.isForeigner && initialUser.domain) {
        this.searchText.set(`${initialUser.account}@${initialUser.domain}`);
        this.searchUser();
      } else {
        this.inviteUser.set(initialUser);
      }
      return;
    }
    const initialTab = this.initialTab() === 'pending' ? 1 : 0;
    this.activeTab.set(initialTab);
    this.observedRequestRevision = this.userService.friendIntentStateRevision();
    this.inviteListsInitialized = true;
    void Promise.all([
      this.loadIncomingInvites(true),
      this.loadOutgoingInvites(true),
    ]);
    if (initialTab === 1) this.userService.markFriendReqRead();
  }
}
