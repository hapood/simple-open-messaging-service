import {
  Component,
  computed,
  effect,
  input,
  signal,
  untracked,
  viewChild,
  OnDestroy,
  ChangeDetectionStrategy,
} from '@angular/core';
import { Observable, Subject, Subscription, finalize } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
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
import { displayUserName } from '../../services/model';
import type { FriendRequestProjection } from '../../services/friend-request-state';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { translateBizResult } from '../../services/biz-code';
import dayjs from 'dayjs';
import { FriendInviteDialogComponent } from '../friend-invite-dialog/friend-invite-dialog.component';
import { VirtualInfiniteListComponent } from '../virtual-infinite-list/virtual-infinite-list.component';
import { FriendRequestCardComponent } from '../friend-request-card/friend-request-card.component';
import { UserIdentityLabelComponent } from '../user-identity-label/user-identity-label.component';
import type { ProfileSelector } from '../../../../../shared/profile-selector';

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
// A relationship-request row derived from the local state-feed projection. `projectionKey` identifies
// the cached row; actions use a local intent id when available and otherwise the exact Address.
type PendingReq = {
  id: string;
  projectionKey: string;
  direction: 'INCOMING' | 'OUTGOING';
  /** Stable Address key used by the avatar and selection projections. */
  peerId?: string;
  name?: string;
  avatar?: string;
  account?: string;
  domain?: string;
  reqMessage?: string;
  status: number; // 0 pending, 1 accepted, -1 invalid, -2 expired, -3 revoked, -4 rejected
  date: number;
  errText: string;
  kind?: 'FRIEND' | 'GROUP';
  sourceLabel?: string;
  profileRev?: number;
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
    MatCardModule,
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
  /** Set when the server reports recognition or Health progress for a federated resolve. */
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
  private searchSub: Subscription | undefined;
  /** Exact account resolution always yields zero or one row. */
  readonly localResults = signal<User[]>([]);
  readonly inviteUser = signal<User | null>(null);
  readonly errMsg = signal('');
  readonly addTabStatus = signal<AddTabStatus>(AddTabStatus.INIT);
  readonly relationshipStates = signal<ReadonlyMap<string, RelationshipState>>(
    new Map(),
  );
  readonly curSearchText = signal('');
  readonly pendingReqList = signal([] as PendingReq[]);
  readonly toPendingErrTxt = signal('');
  readonly sentReqList = signal([] as PendingReq[]);
  readonly sentErrTxt = signal('');
  readonly selectedRequest = signal<PendingReq | null>(null);
  readonly selectedDirection = computed(
    () => this.selectedRequest()?.direction ?? 'INCOMING',
  );
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
  private pendingLoadInFlightGeneration: number | null = null;
  private sentLoadInFlightGeneration: number | null = null;
  private observedRequestRevision: number | undefined;
  private countRefreshGeneration = 0;
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
  private readonly incomingList =
    viewChild<VirtualInfiniteListComponent<PendingReq>>('incomingList');
  private readonly outgoingList =
    viewChild<VirtualInfiniteListComponent<PendingReq>>('outgoingList');

  UserAvatarType = UserAvatarType;
  AddTabStatus = AddTabStatus;
  AppIconType = AppIconType;
  displayUserName = displayUserName;

  openRequest(req: PendingReq): void {
    this.selectedRequest.set(req);
  }

  closeRequest(): void {
    this.selectedRequest.set(null);
  }

  deleteSelected(req: PendingReq): void {
    if (req.direction === 'OUTGOING') this.cancelSent(req);
    else this.rejectIncoming(req);
  }

  rejectIncoming(req: PendingReq): void {
    if (!req.id) return;
    this.runInviteAction(
      req,
      () =>
        this.userService.revokeRelationship({
          account: req.account!,
          domain: req.domain || 'local',
        }),
      (res) => {
        if (res.code === 0) {
          this.pendingReqList.update((items) =>
            items.map((item) =>
              item.id === req.id ? { ...item, status: -4, errText: '' } : item,
            ),
          );
          if (this.selectedRequest()?.id === req.id)
            this.selectedRequest.update((item) =>
              item ? { ...item, status: -4, errText: '' } : item,
            );
        } else {
          this.pendingReqList.update((items) =>
            items.map((item) =>
              item.id === req.id
                ? { ...item, errText: translateBizResult(res, this.transloco) }
                : item,
            ),
          );
        }
      },
    );
  }

  constructor(
    private routeService: RouteService,
    private userService: UserService,
    private transloco: TranslocoService,
    private snackBar: MatSnackBar,
  ) {
    effect(() => {
      const revision = this.userService.relationshipIntentStateRevision();
      if (
        !this.inviteListsInitialized ||
        this.observedRequestRevision === undefined ||
        revision <= this.observedRequestRevision
      ) {
        return;
      }
      this.observedRequestRevision = revision;
      // Preserve the snapshot the user is currently reading. A live revision only updates the tab
      // counters; clicking a counter explicitly replaces that tab with a fresh first page.
      untracked(() => {
        void this.refreshInviteCounts();
      });
    });
  }
  setTab(tab: number) {
    this.activeTab.set(tab);
    if (tab === 1) this.userService.markRelationshipRequestsRead();
  }

  async refreshIncomingTab(): Promise<void> {
    this.setTab(1);
    await this.loadIncomingInvites(true);
    this.incomingList()?.scrollToTop();
  }

  async refreshOutgoingTab(): Promise<void> {
    this.setTab(2);
    await this.loadOutgoingInvites(true);
    this.outgoingList()?.scrollToTop();
  }

  private async refreshInviteCounts(): Promise<void> {
    const generation = ++this.countRefreshGeneration;
    const [incoming, outgoing] = await Promise.allSettled([
      this.userService.listLocalFriendRequests('INCOMING', null, 1),
      this.userService.listLocalFriendRequests('OUTGOING', null, 1),
    ]);
    if (generation !== this.countRefreshGeneration) return;
    if (incoming.status === 'fulfilled')
      this.pendingCount.set(incoming.value.actionableTotal);
    if (outgoing.status === 'fulfilled')
      this.sentCount.set(outgoing.value.total);
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
            .resolveFederatedUser({ account, domain }, (stage) => {
              this.connectingDomain.set(domain);
              this.federationStage.set(stage);
            })
            .subscribe({
              next: ({ user, relationship }) => {
                this.connectingDomain.set(null);
                this.relationshipStates.set(
                  new Map([[this.userIdentity(user), relationship]]),
                );
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

    runResolve();
  }

  /** A single exact account has been resolved: check the P2P relationship
   *  state to decide can-add / already-friends / request-already-sent / they-sent-you-one, then show
   *  the single-user card. Shared by both search paths so the post-select UX is identical. */
  private applySelectedUser(user: User) {
    if (user.isGroup) {
      this.relationshipStates.set(new Map());
      this.localResults.set([user]);
      this.addTabStatus.set(AddTabStatus.SUCCESS);
      return;
    }
    if (this.isSelf(user)) {
      this.relationshipStates.set(new Map());
      this.localResults.set([user]);
      this.addTabStatus.set(AddTabStatus.SUCCESS);
      return;
    }
    this.showResults([user]);
  }

  private async showResults(users: User[]) {
    const states = await Promise.all(
      users.map(
        async (user) =>
          [
            this.userIdentity(user),
            await this.userService.localRelationship(user),
          ] as const,
      ),
    );
    this.relationshipStates.set(new Map(states));
    this.localResults.set(users);
    this.addTabStatus.set(AddTabStatus.SUCCESS);
  }

  activateResult(user: User) {
    if (this.isSelf(user)) return;
    const status =
      this.relationshipStates().get(this.userIdentity(user)) ?? 'NONE';
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

  isSelf(user: Pick<User, 'account' | 'domain'>): boolean {
    const self = this.userService.sessionProfile();
    return (
      !!self &&
      self.account === user.account &&
      (self.domain || 'local') === (user.domain || 'local')
    );
  }

  completeInvite(result: {
    account: string;
    domain: string;
    status: 'OUTGOING_PENDING' | 'FRIEND';
  }) {
    if (this.initialUser()) {
      this.routeService.closeDlg(result);
      return;
    }
    this.relationshipStates.update((states) =>
      new Map(states).set(
        this.addressIdentity(result.account, result.domain),
        result.status,
      ),
    );
    this.inviteUser.set(null);
  }

  relationshipLabel(user: Pick<User, 'account' | 'domain'>): string {
    switch (this.relationshipStates().get(this.userIdentity(user))) {
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

  /** Abort any in-flight resolve and drop the connecting banner. Recognition is idempotent, so an
   * interrupted attempt is safe to repeat on the next search. */
  private cancelInFlight() {
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
      () => this.userService.acceptRelationship(this.inviteAction(req)),
      (res) => {
        if (res.code === 0) {
          // Keep the action terminal while the durable projection and the peer's federated
          // acknowledgement catch up. finalize() clears the in-flight flag synchronously after this
          // callback; without this patch the still-REQUESTED row briefly re-enabled both buttons and
          // then showed the reset loader before the IndexedDB refresh removed/replaced it.
          this.pendingReqList.update((items) =>
            items.map((item) =>
              item.id === req.id ? { ...item, status: 1, errText: '' } : item,
            ),
          );
          // Optimistic "added": patch the current row by identity. A state-feed refresh may have
          // replaced or reordered the list while the request was in flight, so a captured index is
          // not safe. If the authoritative refresh already removed the row, do not resurrect it.
          // Persist the local half without forcing a list reload. The row above already represents the
          // accepted state; the later state-feed delta authoritatively reconciles the retained history
          // row after both federated halves converge. A forced reload here only exposed a spurious loading footer and
          // cannot make peer acknowledgement arrive sooner.
          void this.userService.markRelationshipRequestAccepted(
            req.projectionKey,
          );
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
      () =>
        this.userService.revokeRelationship({
          account: req.account!,
          domain: req.domain || 'local',
        }),
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

  private inviteAction(req: PendingReq): { account: string; domain: string } {
    if (!req.account || !req.domain)
      throw new Error('relationship request projection has no Address');
    return { account: req.account, domain: req.domain };
  }

  private projectionToPending(projection: FriendRequestProjection): PendingReq {
    if (projection.kind === 'FRIEND') {
      const peer = projection.peer!;
      return {
        id: projection.key,
        projectionKey: projection.key,
        direction: projection.direction,
        peerId: this.userIdentity(peer),
        name: peer.name,
        avatar: peer.avatar,
        account: peer.account,
        domain: peer.domain,
        reqMessage: projection.note,
        status:
          projection.status === 'ACCEPTED'
            ? 1
            : projection.status === 'REVOKED'
              ? projection.direction === 'OUTGOING'
                ? -4
                : -3
              : 0,
        date: projection.requestedAt,
        errText: '',
        kind: 'FRIEND',
        profileRev: peer.profileRev,
      };
    }
    const group = projection.group!;
    return {
      id: projection.key,
      projectionKey: projection.key,
      direction: projection.direction,
      peerId: JSON.stringify(['pending-group', group.domain, group.account]),
      name: group.name,
      avatar: group.avatar,
      account: group.account,
      domain: group.domain,
      reqMessage: group.description,
      status:
        projection.status === 'ACCEPTED'
          ? 1
          : projection.status === 'REVOKED'
            ? -4
            : 0,
      date: projection.requestedAt,
      errText: '',
      kind: 'GROUP',
      sourceLabel: group.isLocal
        ? this.transloco.translate('friend.localGroup')
        : group.domain,
      profileRev: group.profileRev,
    };
  }

  userIdentity(peer: Pick<User, 'account' | 'domain'>): string {
    return this.addressIdentity(peer.account, peer.domain ?? 'local');
  }

  private addressIdentity(account: string, domain: string): string {
    return JSON.stringify([domain || 'local', account]);
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
    if (this.pendingLoadInFlightGeneration !== null && !reset) return;
    const generation = reset
      ? ++this.pendingLoadGeneration
      : this.pendingLoadGeneration;
    this.pendingLoadInFlightGeneration = generation;
    if (reset) {
      this.pendingCursor = null;
    }
    this.toPendingErrTxt.set('');

    // The page is read entirely from the local relationship-request projection. The state feed embeds
    // the pending profile snapshot, so rendering does not depend on a legacy server-side invite list.
    try {
      const page = await this.userService.listLocalFriendRequests(
        'INCOMING',
        this.pendingCursor,
        20,
      );
      if (generation !== this.pendingLoadGeneration) return;
      const nextItems = page.items.map((item) =>
        this.projectionToPending(item),
      );
      this.pendingReqList.update((items) =>
        reset ? nextItems : [...items, ...nextItems],
      );
      this.pendingCursor = page.scannedThrough;
      this.pendingHasMore.set(page.hasMore);
      this.pendingCount.set(page.actionableTotal);
    } catch {
      if (generation !== this.pendingLoadGeneration) return;
      this.toPendingErrTxt.set(
        this.transloco.translate('friend.error.unknownError'),
      );
    } finally {
      if (this.pendingLoadInFlightGeneration === generation)
        this.pendingLoadInFlightGeneration = null;
    }
  }

  async loadOutgoingInvites(reset = false) {
    if (this.sentLoadInFlightGeneration !== null && !reset) return;
    const generation = reset
      ? ++this.sentLoadGeneration
      : this.sentLoadGeneration;
    this.sentLoadInFlightGeneration = generation;
    if (reset) {
      this.sentCursor = null;
    }
    this.sentErrTxt.set('');

    try {
      const page = await this.userService.listLocalFriendRequests(
        'OUTGOING',
        this.sentCursor,
        20,
      );
      if (generation !== this.sentLoadGeneration) return;
      const nextItems = page.items.map((item) =>
        this.projectionToPending(item),
      );
      this.sentReqList.update((items) =>
        reset ? nextItems : [...items, ...nextItems],
      );
      this.sentCursor = page.scannedThrough;
      this.sentHasMore.set(page.hasMore);
      this.sentCount.set(page.total);
    } catch {
      if (generation !== this.sentLoadGeneration) return;
      this.sentErrTxt.set(
        this.transloco.translate('friend.error.unknownError'),
      );
    } finally {
      if (this.sentLoadInFlightGeneration === generation)
        this.sentLoadInFlightGeneration = null;
    }
  }

  profileEvidence(request: PendingReq): ProfileSelector | undefined {
    return request.account && request.domain && request.profileRev
      ? {
          type: 'EXACT',
          account: request.account,
          domain: request.domain,
          rev: request.profileRev,
        }
      : undefined;
  }

  ngOnInit() {
    const initialUser = this.initialUser();
    if (initialUser) {
      this.activeTab.set(0);
      if (initialUser.domain !== 'local' && initialUser.domain) {
        this.searchText.set(`${initialUser.account}@${initialUser.domain}`);
        this.searchUser();
      } else {
        this.inviteUser.set(initialUser);
      }
      return;
    }
    const initialTab = this.initialTab() === 'pending' ? 1 : 0;
    this.activeTab.set(initialTab);
    this.observedRequestRevision =
      this.userService.relationshipIntentStateRevision();
    this.inviteListsInitialized = true;
    void Promise.all([
      this.loadIncomingInvites(true),
      this.loadOutgoingInvites(true),
    ]);
    if (initialTab === 1) this.userService.markRelationshipRequestsRead();
  }
}
