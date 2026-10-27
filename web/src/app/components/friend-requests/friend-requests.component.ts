import { RequestProjectionStatus, type RequestProjectionStatusValue } from '../../../../../shared/request-projection-status';
import type { RequestRecord } from '../../../../../shared/relationship-request';
import { parseRequestSnapshot, type RequestSnapshot } from '../../../../../shared/request-snapshot';
import type { RequestDecisionResult } from '../../../../../shared/relationship-request';
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
import { AsyncPipe } from '@angular/common';
import { Observable, Subject, Subscription, finalize } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatTabsModule } from '@angular/material/tabs';
import { ToastService } from '../../services/toast.service';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService } from '../../services/route.service';
import type { AvatarProfileRef } from '../../services/avatar-profile-ref';
import { PageHeaderComponent } from '../page-header/page-header.component';
import { UserService, User } from '../../services/user.service';
import { type InviteSubject, type StandardResponse } from '../../services/model';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import { SnapshotAvatarComponent } from '../user-avatar/snapshot-avatar.component';
import { UserAvatarType } from '../user-avatar/model';
import { translateBizResult } from '../../services/biz-code';
import dayjs from 'dayjs';
import { FriendInviteDialogComponent } from '../friend-invite-dialog/friend-invite-dialog.component';
import { VirtualInfiniteListComponent } from '../virtual-infinite-list/virtual-infinite-list.component';
import { FriendRequestCardComponent } from '../friend-request-card/friend-request-card.component';
import { UserIdentityLabelComponent } from '../user-identity-label/user-identity-label.component';
import { NamespaceDomainPipe } from '../../pipes/namespace-domain.pipe';

import { IdentitySearch } from '../../services/identity-search';
import { IdentitySearchComponent } from '../identity-search/identity-search.component';
// One server-owned request round as shown in this dialog. Actions always use the
// exact requestId so an older card can never address a newer round.
type PendingReq = {
  id: string;
  requestId: string;
  direction: 'INCOMING' | 'OUTGOING';
  /** Stable Address key used by the avatar and selection projections. */
  peerId?: string;
  account: string;
  namespaceId: number;
  reqMessage?: string;
  status: RequestProjectionStatusValue;
  date: number;
  errText: string;
  kind?: 'FRIEND' | 'GROUP';
  profileRev?: number;
  snapshot: RequestSnapshot | null;
};
type RelationshipState =
  | 'NONE'
  | 'OUTGOING_PENDING'
  | 'INCOMING_PENDING'
  | 'FRIEND';

@Component({
  selector: 'app-friend-requests',
  imports: [
    IdentitySearchComponent,
    AsyncPipe,
    DemandAvatarComponent,
    SnapshotAvatarComponent,
    MatButtonModule,
    MatCardModule,
    MatTabsModule,
    PageHeaderComponent,
    TranslocoPipe,
    FriendInviteDialogComponent,
    VirtualInfiniteListComponent,
    FriendRequestCardComponent,
    UserIdentityLabelComponent,
    NamespaceDomainPipe,
  ],
  templateUrl: './friend-requests.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './friend-requests.component.scss',
})
export class FriendRequestsComponent implements OnDestroy {
  readonly RequestProjectionStatus = RequestProjectionStatus;
  readonly searchText = signal('');
  readonly lookup = new IdentitySearch();
  readonly inviteUser = signal<InviteSubject | null>(null);
  readonly relationshipStates = signal<ReadonlyMap<string, RelationshipState>>(
    new Map(),
  );

  readonly resultItemKey = (_index: number, user: User) => this.userIdentity(user);
  readonly requestItemKey = (_index: number, request: PendingReq) => request.id;
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
  readonly loadingIncoming = signal(false);
  readonly loadingOutgoing = signal(false);
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
  initialUser = input<InviteSubject | undefined>(undefined);
  /** Fixed address snapshots are resolved before assigning namespace coordinates or relationship state. */
  initialAddress = input<
    | {
        account: string;
        domain: string;
        publicKey: string;
      }
    | undefined
  >(undefined);
  activeTab = signal(0);
  isShowBackBtn = signal(true);
  private readonly incomingList =
    viewChild<VirtualInfiniteListComponent<PendingReq>>('incomingList');
  private readonly outgoingList =
    viewChild<VirtualInfiniteListComponent<PendingReq>>('outgoingList');

  UserAvatarType = UserAvatarType;

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
        this.userService.rejectRelationshipRequest({ requestId: req.requestId }),
      (res) => {
        if (res.code === 0 && res.data !== undefined && res.data.status === 'OK') {
          this.pendingReqList.update((items) =>
            items.map((item) =>
              item.id === req.id
                ? {
                    ...item,
                    status: RequestProjectionStatus.REJECTED,
                    errText: '',
                  }
                : item,
            ),
          );
          if (this.selectedRequest()?.id === req.id)
            this.selectedRequest.update((item) =>
              item
                ? {
                    ...item,
                    status: RequestProjectionStatus.REJECTED,
                    errText: '',
                  }
                : item,
            );
        } else {
          this.pendingReqList.update((items) =>
            items.map((item) =>
              item.id === req.id
                ? { ...item, errText: this.requestFailureText(res) }
                : item,
            ),
          );
        }
      },
    );
  }

  /** Transport failures keep the business message; round-level failures map
   * to the decision status copy because the envelope code stays zero. */
  private requestFailureText(
    res: StandardResponse<RequestDecisionResult>,
  ): string {
    if (res.code !== 0) return translateBizResult(res, this.transloco);
    return this.transloco.translate(
      res.data?.status === 'EXPIRED'
        ? 'errors.requestExpired'
        : 'errors.requestStale',
    );
  }

  constructor(
    private routeService: RouteService,
    private userService: UserService,
    private transloco: TranslocoService,
    private toastService: ToastService,
  ) {}
  setTab(tab: number) {
    this.activeTab.set(tab);
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
    // Counts reflect the loaded seven-day pages; the server exposes no totals.
    this.pendingCount.set(
      this.pendingReqList().filter(
        (item) => item.status === RequestProjectionStatus.REQUESTED,
      ).length,
    );
    this.sentCount.set(this.sentReqList().length);
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
    const address = this.initialAddress();
    this.relationshipStates.set(new Map());
    this.lookup.search(
      address ? `${address.account}@${address.domain}` : this.searchText(),
      {
        publicKey: address?.publicKey,
        prepare: (user, isCurrent) => {
          if (this.isSelf(user)) return;
          return this.userService.localRelationship(user).then((state) => {
            if (isCurrent())
              this.relationshipStates.set(new Map([[this.userIdentity(user), state]]));
          });
        },
      },
    );
  }

  activateResult(user: InviteSubject) {
    if (this.isSelf(user)) return;
    const status =
      this.relationshipStates().get(this.userIdentity(user)) ?? 'NONE';
    if (status === 'INCOMING_PENDING') {
      this.setTab(1);
      return;
    }
    if (status === 'NONE') this.openInviteDialog(user);
  }

  openInviteDialog(user: InviteSubject) {
    if (this.isSelf(user)) return;
    this.inviteUser.set(user);
  }

  isSelf(user: Pick<User, 'account' | 'namespaceId'>): boolean {
    const self = this.userService.sessionProfile();
    return (
      !!self &&
      self.account === user.account &&
      self.namespaceId === user.namespaceId
    );
  }

  completeInvite(result: {
    account: string;
    namespaceId: number;
    status: 'OUTGOING_PENDING' | 'FRIEND';
  }) {
    if (this.initialUser()) {
      this.routeService.closeDlg(result);
      return;
    }
    this.relationshipStates.update((states) =>
      new Map(states).set(
        this.identityKey(result.account, result.namespaceId),
        result.status,
      ),
    );
    this.inviteUser.set(null);
  }

  relationshipLabel(user: Pick<User, 'account' | 'namespaceId'>): string {
    if (user.account.startsWith('!'))
      return this.relationshipStates().get(this.userIdentity(user)) === 'FRIEND'
        ? 'chat.alreadyJoined'
        : 'friend.joinGroup';
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

  cancelSearch() {
    this.lookup.cancel();
    const address = this.initialAddress();
    this.searchText.set(address ? `${address.account}@${address.domain}` : '');
  }

  ngOnDestroy() {
    this.lookup.cancel();
    this.cancelInviteActions();
  }

  approve(req: PendingReq) {
    if (!this.pendingReqList().some((item) => item.id === req.id)) return;
    this.runInviteAction(
      req,
      () => this.userService.acceptRelationship({ requestId: req.requestId }),
      (res) => {
        const outcome = res.code === 0 ? res.data : undefined;
        const settled = outcome?.status === 'OK';
        if (settled) {
          this.pendingReqList.update((items) =>
            items.map((item) =>
              item.id === req.id
                ? { ...item, status: RequestProjectionStatus.ACCEPTED, errText: '' }
                : item,
            ),
          );
          if (this.selectedRequest()?.id === req.id) this.closeRequest();
          this.refreshInviteCounts();
          return;
        }
        // The round changed underneath this card: reload the authoritative page.
        this.pendingReqList.update((items) =>
          items.map((item) =>
            item.id === req.id
              ? { ...item, errText: this.requestFailureText(res) }
              : item,
          ),
        );
        void this.loadIncomingInvites(true);
      },
    );
  }

  cancelSent(req: PendingReq) {
    this.runInviteAction(
      req,
      () => this.userService.withdrawRelationshipRequest({ requestId: req.requestId }),
      (res) => {
        if (res.code === 0 && res.data !== undefined && res.data.status === 'OK') {
          // Keep the tombstone visible so the sent-request history reflects the final state.
          this.sentReqList.update((items) =>
            items.map((item) =>
              item.id === req.id
                ? {
                    ...item,
                    status: RequestProjectionStatus.WITHDRAWN,
                    errText: '',
                  }
                : item,
            ),
          );
          if (this.selectedRequest()?.id === req.id)
            this.selectedRequest.update((item) =>
              item
                ? {
                    ...item,
                    status: RequestProjectionStatus.WITHDRAWN,
                    errText: '',
                  }
                : item,
            );
          this.toastService.info(
            this.transloco.translate('friend.revokedToast'),
            { duration: 3000 },
          );
        } else {
          // Failed: keep it and tag the error copy.
          this.sentReqList.set(
            this.sentReqList().map((r) =>
              r.id === req.id
                ? { ...r, errText: this.requestFailureText(res) }
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

  private projectionToPending(record: RequestRecord): PendingReq {
    const endpoint = record.direction === 'OUTGOING' ? record.receiver : record.author;
    const snapshot = record.direction === 'OUTGOING'
      ? parseRequestSnapshot(record.snapshot)
      : null;
    const kind: 'FRIEND' | 'GROUP' = record.kind === 'FRIEND' ? 'FRIEND' : 'GROUP';
    const authorProfile = record.direction === 'INCOMING' ? record.authorProfile : undefined;
    return {
      id: record.id,
      requestId: record.id,
      direction: record.direction,
      peerId: this.identityKey(endpoint.account, endpoint.namespaceId),
      account: endpoint.account,
      namespaceId: endpoint.namespaceId,
      reqMessage: record.note,
      status: record.status,
      date: Date.parse(record.requestedAt),
      errText: '',
      kind,
      ...(authorProfile
        ? { profileRev: authorProfile.profileRev }
        : {}),
      snapshot,
    };
  }

  requestStatusLabel(status: RequestProjectionStatusValue): string {
    switch (status) {
      case RequestProjectionStatus.ACCEPTED:
        return 'friend.approved';
      case RequestProjectionStatus.WITHDRAWN:
        return 'friend.revoked';
      case RequestProjectionStatus.REJECTED:
        return 'friend.rejected';
      case RequestProjectionStatus.EXPIRED:
        return 'friend.expired';
      default:
        return 'group.invitationPending';
    }
  }

  userIdentity(peer: Pick<User, 'account' | 'namespaceId'>): string {
    return this.identityKey(peer.account, peer.namespaceId);
  }

  private identityKey(account: string, namespaceId: number): string {
    return JSON.stringify([namespaceId, account]);
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
    this.loadingIncoming.set(true);
    if (reset) {
      this.pendingCursor = null;
    }
    this.toPendingErrTxt.set('');

    // The online query is the only source; there is no durable local request list.
    try {
      const res = await firstValueFrom(
        this.userService.queryRelationshipRequests({
          bucket: 'RECEIVED',
          ...(this.pendingCursor
            ? { before: this.pendingCursor }
            : {}),
          take: 20,
        }),
      );
      const page = res.data;
      if (res.code !== 0 || !page) throw new Error(res.message);
      if (generation !== this.pendingLoadGeneration) return;
      const nextItems = page.items.map((item) => this.projectionToPending(item));
      this.pendingReqList.update((items) =>
        reset ? nextItems : [...items, ...nextItems],
      );
      this.pendingCursor = page.before;
      this.pendingHasMore.set(page.hasMore);
      this.pendingCount.set(
        this.pendingReqList().filter(
          (item) => item.status === RequestProjectionStatus.REQUESTED,
        ).length,
      );
      // Viewing the received page marks it read: persist the intent, then submit.
      void this.userService
        .observeIncomingRequestPage(page.incomingHead)
        .catch(() => undefined);
    } catch {
      if (generation !== this.pendingLoadGeneration) return;
      this.toPendingErrTxt.set(
        this.transloco.translate('friend.error.unknownError'),
      );
    } finally {
      if (this.pendingLoadInFlightGeneration === generation) {
        this.pendingLoadInFlightGeneration = null;
        this.loadingIncoming.set(false);
      }
    }
  }

  async loadOutgoingInvites(reset = false) {
    if (this.sentLoadInFlightGeneration !== null && !reset) return;
    const generation = reset
      ? ++this.sentLoadGeneration
      : this.sentLoadGeneration;
    this.sentLoadInFlightGeneration = generation;
    this.loadingOutgoing.set(true);
    if (reset) {
      this.sentCursor = null;
    }
    this.sentErrTxt.set('');

    try {
      const res = await firstValueFrom(
        this.userService.queryRelationshipRequests({
          bucket: 'SENT',
          ...(this.sentCursor ? { before: this.sentCursor } : {}),
          take: 20,
        }),
      );
      const page = res.data;
      if (res.code !== 0 || !page) throw new Error(res.message);
      if (generation !== this.sentLoadGeneration) return;
      const nextItems = page.items.map((item) => this.projectionToPending(item));
      this.sentReqList.update((items) =>
        reset ? nextItems : [...items, ...nextItems],
      );
      this.sentCursor = page.before;
      this.sentHasMore.set(page.hasMore);
      this.sentCount.set(this.sentReqList().length);
    } catch {
      if (generation !== this.sentLoadGeneration) return;
      this.sentErrTxt.set(
        this.transloco.translate('friend.error.unknownError'),
      );
    } finally {
      if (this.sentLoadInFlightGeneration === generation) {
        this.sentLoadInFlightGeneration = null;
        this.loadingOutgoing.set(false);
      }
    }
  }

  avatarProfile(request: PendingReq): AvatarProfileRef | undefined {
    if (request.direction === 'OUTGOING') {
      parseRequestSnapshot(request.snapshot);
      return undefined;
    }
    return request.account && request.profileRev
      ? {
          account: request.account,
          publisherNamespaceId: request.namespaceId,
          profileNamespaceId: 0,
          rev: request.profileRev,
          linked: true,
        }
      : undefined;
  }

  ngOnInit() {
    const address = this.initialAddress();
    if (address) {
      this.activeTab.set(0);
      this.searchText.set(`${address.account}@${address.domain}`);
      this.searchUser();
      return;
    }
    const initialUser = this.initialUser();
    if (initialUser) {
      this.activeTab.set(0);
      if (initialUser.namespaceId === 0) {
        this.inviteUser.set(initialUser);
      } else {
        this.searchText.set(
          `${initialUser.account}@${initialUser.domain ?? ''}`,
        );
        this.searchUser();
      }
      return;
    }
    const initialTab = this.initialTab() === 'pending' ? 1 : 0;
    this.activeTab.set(initialTab);
    this.inviteListsInitialized = true;
    void Promise.all([
      this.loadIncomingInvites(true),
      this.loadOutgoingInvites(true),
    ]);
  }
}
