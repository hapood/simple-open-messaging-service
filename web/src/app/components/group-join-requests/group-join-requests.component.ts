import { HttpClient } from '@angular/common/http';
import { avatarBlobDataUrl } from '../../services/profile-avatar-bytes';
import { assetUrl } from '../../services/runtime';
import { SessionLifecycleService } from '../../services/session-lifecycle.service';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { parseRequestSnapshot } from '../../../../../shared/request-snapshot';
import type { RequestRecord } from '../../../../../shared/relationship-request';
import type { AvatarProfileRef } from '../../services/avatar-profile-ref';
import { RequestProjectionStatus } from '../../../../../shared/request-projection-status';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnDestroy,
  signal,
} from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  defer,
  filter,
  finalize,
  firstValueFrom,
  from,
  fromEvent,
  map,
  Observable,
  of,
  Subscription,
  switchMap,
  take,
  takeUntil,
} from 'rxjs';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { GroupService } from '../../services/group.service';
import type { User } from '../../services/model';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { PageHeaderComponent } from '../page-header/page-header.component';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import { SnapshotAvatarComponent } from '../user-avatar/snapshot-avatar.component';
import { UserAvatarType } from '../user-avatar/model';
import { UserIdentityLabelComponent } from '../user-identity-label/user-identity-label.component';
import { ToastService } from '../../services/toast.service';
import { translateBizResult } from '../../services/biz-code';
import {
  FederatedResolveError,
  type FederatedResolveStage,
  UserService,
} from '../../services/user.service';
import {
  applyGroupJoinRequestAction,
  hasUnreadGroupJoinRequests,
  mergeGroupJoinRequestPage,
} from '../../services/group-join-request-state';
import { NamespaceDomainPipe } from '../../pipes/namespace-domain.pipe';

type RequestListKind = 'INVITATION' | 'APPLICATION';

@Component({
  selector: 'app-group-join-requests',
  imports: [
    AsyncPipe,
    FormsModule,
    MatButtonModule,
    MatProgressBarModule,
    MatTabsModule,
    PageHeaderComponent,
    TranslocoPipe,
    DemandAvatarComponent,
    SnapshotAvatarComponent,
    UserIdentityLabelComponent,
    NamespaceDomainPipe,
  ],
  templateUrl: './group-join-requests.component.html',
  styleUrl: './group-join-requests.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupJoinRequestsComponent implements OnDestroy {
  readonly UserAvatarType = UserAvatarType;
  private readonly groups = inject(GroupService);
  private readonly http = inject(HttpClient);
  private readonly sessionLifecycle = inject(SessionLifecycleService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly conversations = inject(ConversationListService);
  private readonly users = inject(UserService);
  private readonly nav = inject(NavStateMachineService);
  private readonly toast = inject(ToastService);
  private readonly transloco = inject(TranslocoService);
  private readonly groupChanges$ = toObservable(
    this.conversations.openThreadId,
  );

  readonly activeTab = signal(0);
  readonly invitations = signal<RequestRecord[]>([]);
  readonly applications = signal<RequestRecord[]>([]);
  readonly candidates = signal<User[]>([]);
  private readonly sentInvitations = signal<ReadonlySet<string>>(new Set());
  readonly loadingInvitations = signal(false);
  readonly loadingApplications = signal(false);
  readonly loadingCandidates = signal(false);
  readonly invitationsHasMore = signal(false);
  readonly applicationsHasMore = signal(false);
  readonly candidatesHasMore = signal(false);
  readonly acting = signal<ReadonlySet<string>>(new Set());
  readonly inviting = signal<ReadonlySet<string>>(new Set());
  readonly searchText = signal('');
  readonly appliedSearch = signal('');
  readonly federatedAddress = signal<{
    account: string;
    domain: string;
  } | null>(null);
  readonly invalidGroupAddress = signal(false);
  readonly resolvingFederated = signal(false);
  readonly federationStage = signal<FederatedResolveStage>('DISCOVERING');

  private invitationBefore?: string;
  private applicationBefore?: string;
  private searchOffset = 0;
  private resolveSub?: Subscription;

  constructor() {
    const threadId = this.conversations.openThreadId();
    const thread = this.conversations
      .items()
      .find((item) => item.threadId === threadId);
    const hasUnreadApplications = hasUnreadGroupJoinRequests(thread);
    if (hasUnreadApplications) {
      this.activeTab.set(1);
      void this.loadRequests('APPLICATION', false);
    } else {
      void this.loadRequests('INVITATION', false);
    }
  }

  invitationSnapshot(request: RequestRecord) {
    return parseRequestSnapshot(
      request.direction === 'OUTGOING' ? request.snapshot : null,
    );
  }

  applicationProfile(request: RequestRecord): AvatarProfileRef {
    const authorProfile =
      request.direction === 'INCOMING' ? request.authorProfile : null;
    return {
      account: request.author.account,
      publisherNamespaceId: request.author.namespaceId,
      profileNamespaceId: authorProfile?.profileNamespaceId ?? 0,
      rev: authorProfile?.profileRev ?? 0,
      linked: request.status === 'REQUESTED' || request.status === 'ACCEPTED',
    };
  }

  /** Requests act by permanent request id; invite candidates have none yet. */
  requestKey(request: RequestRecord): string {
    return request.id;
  }

  close(): void {
    this.nav.back();
  }

  setTab(index: number): void {
    this.activeTab.set(index);
    if (index === 1 && this.applications().length === 0) {
      void this.loadRequests('APPLICATION', false);
    }
  }

  search(): void {
    this.resolveSub?.unsubscribe();
    const query = this.searchText().trim();
    this.appliedSearch.set(query);
    this.invalidGroupAddress.set(/^!\S+@\S+$/.test(query));
    this.federatedAddress.set(null);
    this.candidates.set([]);
    this.candidatesHasMore.set(false);
    const address = /^([^@\s]+)@([^@\s]+)$/.exec(query);
    if (address) {
      if (!this.invalidGroupAddress()) {
        this.federatedAddress.set({ account: address[1], domain: address[2] });
      }
      return;
    }
    void this.loadCandidates(false);
  }

  loadMoreRequests(kind: RequestListKind): void {
    void this.loadRequests(kind, true);
  }
  loadMoreCandidates(): void {
    void this.loadCandidates(true);
  }

  async handleApplication(
    application: RequestRecord,
    accept: boolean,
  ): Promise<void> {
    const groupId = this.conversations.openThreadId();
    const key = this.requestKey(application);
    if (groupId === undefined || this.acting().has(key)) return;
    this.addActing(key);
    try {
      const res = await firstValueFrom(
        accept
          ? this.groups.acceptJoinRequest({
              groupId,
              requestId: application.id,
            })
          : this.groups.rejectJoinRequest({
              groupId,
              requestId: application.id,
            }),
      );
      if (res.code !== 0) return this.showBusinessError(res);
      if (res.data?.status !== 'OK') {
        this.toast.warn(
          this.transloco.translate(
            res.data?.status === 'EXPIRED'
              ? 'errors.requestExpired'
              : 'errors.requestStale',
          ),
        );
        void this.loadRequests('APPLICATION', false);
        return;
      }
      this.applications.update((rows) =>
        rows.map((row) =>
          row.id === application.id
            ? applyGroupJoinRequestAction(row, accept ? 'ACCEPT' : 'REJECT')
            : row,
        ),
      );
    } catch {
      this.showNetworkError();
    } finally {
      this.removeActing(key);
    }
  }

  async revokeInvitation(invitation: RequestRecord): Promise<void> {
    const groupId = this.conversations.openThreadId();
    const key = this.requestKey(invitation);
    if (groupId === undefined || this.acting().has(key)) return;
    this.addActing(key);
    try {
      const res = await firstValueFrom(
        this.groups.revokeInvitation({
          groupId,
          requestId: invitation.id,
        }),
      );
      if (res.code !== 0) return this.showBusinessError(res);
      if (res.data?.status !== 'OK') {
        this.toast.warn(
          this.transloco.translate(
            res.data?.status === 'EXPIRED'
              ? 'errors.requestExpired'
              : 'errors.requestStale',
          ),
        );
        void this.loadRequests('INVITATION', false);
        return;
      }
      this.invitations.update((rows) =>
        rows.map((row) =>
          row.id === invitation.id
            ? { ...row, status: RequestProjectionStatus.WITHDRAWN }
            : row,
        ),
      );
      this.sentInvitations.update((keys) => {
        const next = new Set(keys);
        next.delete(this.candidateKey(invitation.receiver));
        return next;
      });
    } catch {
      this.showNetworkError();
    } finally {
      this.removeActing(key);
    }
  }

  invitationState(user: User): 'AVAILABLE' | 'INVITED' | 'NOT_FRIEND' {
    const key = this.candidateKey(user);
    const pending = this.invitations().some(
      (request) =>
        request.status === 'REQUESTED' &&
        new Date(request.expiresAt ?? 0).getTime() > Date.now() &&
        this.candidateKey(request.receiver) === key,
    );
    if (pending || this.sentInvitations().has(key)) return 'INVITED';
    const friend = this.conversations
      .items()
      .some(
        (thread) =>
          thread.type === 'P2P' &&
          thread.friendshipActive !== false &&
          thread.conversationState === 'ACTIVE' &&
          this.candidateKey(thread.peerUser) === key,
      );
    return friend ? 'AVAILABLE' : 'NOT_FRIEND';
  }

  candidateKey(candidate: { account: string; namespaceId: number }): string {
    return JSON.stringify([candidate.namespaceId, candidate.account]);
  }

  invite(candidate: User): void {
    const groupId = this.conversations.openThreadId();
    const key = this.candidateKey(candidate);
    if (groupId === undefined || this.inviting().has(key)) return;
    const session = this.sessionLifecycle.capture();
    this.inviting.update((ids) => new Set(ids).add(key));
    // Lookup endpoints supply display data directly; the send boundary is the
    // only place it freezes into bytes. An unpublished candidate carries the
    // account-name fallback from the server.
    defer(() => {
      const avatar: Observable<string | null> = !candidate.avatar
        ? of(null)
        : candidate.avatar.startsWith('data:')
          ? of(candidate.avatar)
          : this.http
              .get(assetUrl(candidate.avatar), { responseType: 'blob' })
              .pipe(switchMap((blob) => from(avatarBlobDataUrl(blob))));
      return avatar.pipe(
        map((value) =>
          parseRequestSnapshot({ displayName: candidate.name, avatar: value }),
        ),
      );
    })
      .pipe(
        take(1),
        switchMap((snapshot) =>
          this.groups.inviteUsers({
            groupId,
            users: [
              {
                account: candidate.account,
                namespaceId: candidate.namespaceId,
                snapshot,
              },
            ],
          }),
        ),
        takeUntil(fromEvent(session.signal, 'abort')),
        takeUntil(
          this.groupChanges$.pipe(
            filter(() => this.conversations.openThreadId() !== groupId),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
        finalize(() =>
          this.inviting.update((ids) => {
            const next = new Set(ids);
            next.delete(key);
            return next;
          }),
        ),
      )
      .subscribe({
        next: (res) => {
          if (res.code !== 0) return this.showBusinessError(res);
          const rejection = res.data?.skipped[0];
          if (rejection) {
            if (
              rejection.reason === 'ALREADY_MEMBER' ||
              rejection.reason === 'ALREADY_INVITED'
            ) {
              this.toast.warn(
                this.transloco.translate(
                  rejection.reason === 'ALREADY_MEMBER'
                    ? 'group.alreadyMember'
                    : 'group.invitedStatus',
                ),
              );
            } else {
              this.showBusinessError(rejection);
            }
            return;
          }
          if (!res.data?.invited.length) {
            this.toast.warn(
              this.transloco.translate('group.inviteUnavailable'),
            );
            return;
          }
          this.sentInvitations.update((keys) => new Set(keys).add(key));
          void this.loadRequests('INVITATION', false);
        },
        error: () => this.showNetworkError(),
      });
  }

  resolveFederated(): void {
    const address = this.federatedAddress();
    if (!address || this.resolvingFederated()) return;
    const session = this.sessionLifecycle.capture();
    const groupId = this.conversations.openThreadId();
    this.resolvingFederated.set(true);
    this.federationStage.set('DISCOVERING');
    this.resolveSub = this.users
      .resolveFederatedUser(address, (stage) => this.federationStage.set(stage))
      .pipe(
        takeUntil(fromEvent(session.signal, 'abort')),
        takeUntil(
          this.groupChanges$.pipe(
            filter(() => this.conversations.openThreadId() !== groupId),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.resolvingFederated.set(false)),
      )
      .subscribe({
        next: ({ user }) => {
          if (user.isGroup) {
            this.invalidGroupAddress.set(true);
            return;
          }

          if (
            !this.sessionLifecycle.isCurrent(session) ||
            this.conversations.openThreadId() !== groupId
          )
            return;
          this.candidates.set([user]);
          this.federatedAddress.set(null);
        },
        error: (error: unknown) => {
          const key =
            error instanceof FederatedResolveError &&
            error.reason === 'NOT_FOUND'
              ? 'group.noMatchingFriends'
              : 'errors.networkError';
          this.toast.warn(this.transloco.translate(key));
        },
      });
  }

  applicationStatusKey(status: RequestRecord['status']): string {
    switch (status) {
      case RequestProjectionStatus.ACCEPTED:
        return 'group.joinRequestAccepted';
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

  requestStatusKey(status: RequestRecord['status']): string {
    return this.applicationStatusKey(status);
  }

  candidateActionKey(candidate: User): string {
    if (this.inviting().has(this.candidateKey(candidate)))
      return 'group.inviting';
    const state = this.invitationState(candidate);
    if (state === 'INVITED') return 'group.invitedStatus';
    if (state === 'NOT_FRIEND') return 'group.friendRequired';
    return 'group.inviteAction';
  }

  ngOnDestroy(): void {
    this.resolveSub?.unsubscribe();
  }

  private async loadRequests(
    kind: RequestListKind,
    append: boolean,
  ): Promise<void> {
    const groupId = this.conversations.openThreadId();
    if (groupId === undefined) return;
    const loading =
      kind === 'INVITATION'
        ? this.loadingInvitations
        : this.loadingApplications;
    if (loading()) return;
    loading.set(true);
    try {
      const before =
        kind === 'INVITATION' ? this.invitationBefore : this.applicationBefore;
      const res = await firstValueFrom(
        kind === 'INVITATION'
          ? this.groups.queryInvitations({
              groupId,
              before: append ? before : undefined,
              take: 20,
            })
          : this.groups.queryJoinRequests({
              groupId,
              before: append ? before : undefined,
              take: 20,
            }),
      );
      if (res.code !== 0 || !res.data) return this.showBusinessError(res);
      const target =
        kind === 'INVITATION' ? this.invitations : this.applications;
      target.update((rows) =>
        mergeGroupJoinRequestPage(append ? rows : [], res.data!.items),
      );
      if (kind === 'INVITATION') {
        this.invitationBefore = res.data.before ?? undefined;
        this.invitationsHasMore.set(res.data.hasMore);
      } else {
        this.applicationBefore = res.data.before ?? undefined;
        this.applicationsHasMore.set(res.data.hasMore);
        if (!append && res.data.joinRequestEndFeedId > 0)
          this.markApplicationsRead(res.data.joinRequestEndFeedId);
      }
    } catch {
      this.showNetworkError();
    } finally {
      loading.set(false);
    }
  }

  private loadCandidates(append: boolean): void {
    const groupId = this.conversations.openThreadId();
    const query = this.appliedSearch();
    if (groupId === undefined || this.loadingCandidates() || query.length < 2)
      return;
    const session = this.sessionLifecycle.capture();
    const offset = append ? this.searchOffset : 0;
    this.loadingCandidates.set(true);
    this.resolveSub = this.users
      .searchUsers({ q: query, skip: offset, take: 20 })
      .pipe(
        takeUntil(fromEvent(session.signal, 'abort')),
        takeUntil(
          this.groupChanges$.pipe(
            filter(() => this.conversations.openThreadId() !== groupId),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.loadingCandidates.set(false)),
      )
      .subscribe({
        next: (res) => {
          if (res.code !== 0 || !res.data) return this.showBusinessError(res);
          const snapshots = res.data.list.filter((user) => !user.isGroup);
          this.candidates.update((rows) =>
            append ? [...rows, ...snapshots] : snapshots,
          );
          this.searchOffset = offset + res.data.list.length;
          this.candidatesHasMore.set(this.searchOffset < res.data.total);
        },
        error: () => this.showNetworkError(),
      });
  }

  private markApplicationsRead(joinRequestReadFeedId: number): void {
    const threadId = this.conversations.openThreadId();
    const thread = this.conversations
      .items()
      .find((item) => item.threadId === threadId);
    if (
      threadId === undefined ||
      !thread ||
      !hasUnreadGroupJoinRequests(thread)
    )
      return;
    this.groups
      .markJoinRequestsRead({
        groupId: threadId,
        joinRequestReadFeedId,
      })
      .subscribe({
        next: (result) => {
          if (result.code === 0) {
            this.conversations.markJoinRequestsReadLocally(
              threadId,
              joinRequestReadFeedId,
            );
          } else {
            this.showBusinessError(result);
          }
        },
        error: () => this.showNetworkError(),
      });
  }

  private addActing(id: string): void {
    this.acting.update((ids) => new Set(ids).add(id));
  }
  private removeActing(id: string): void {
    this.acting.update((ids) => {
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
  }
  private showBusinessError(res: {
    code: number;
    message: string;
    messageKey?: string;
  }): void {
    this.toast.warn(translateBizResult(res, this.transloco));
  }
  private showNetworkError(): void {
    this.toast.warn(this.transloco.translate('errors.networkError'));
  }
}
