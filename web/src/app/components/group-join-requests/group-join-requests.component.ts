import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnDestroy,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom, Subscription } from 'rxjs';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTabsModule } from '@angular/material/tabs';
import {
  GroupService,
  type GroupInviteCandidate,
  type GroupJoinRequest,
} from '../../services/group.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { PageHeaderComponent } from '../page-header/page-header.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
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
  mergeGroupJoinRequestPage,
} from '../../services/group-join-request-state';

type RequestListKind = 'INVITATION' | 'APPLICATION';

@Component({
  selector: 'app-group-join-requests',
  imports: [
    FormsModule,
    MatButtonModule,
    MatProgressBarModule,
    MatTabsModule,
    PageHeaderComponent,
    TranslocoPipe,
    UserAvatarComponent,
    UserIdentityLabelComponent,
  ],
  templateUrl: './group-join-requests.component.html',
  styleUrl: './group-join-requests.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupJoinRequestsComponent implements OnDestroy {
  readonly UserAvatarType = UserAvatarType;
  private readonly groups = inject(GroupService);
  private readonly conversations = inject(ConversationListService);
  private readonly users = inject(UserService);
  private readonly nav = inject(NavStateMachineService);
  private readonly toast = inject(ToastService);
  private readonly transloco = inject(TranslocoService);

  readonly activeTab = signal(0);
  readonly invitations = signal<GroupJoinRequest[]>([]);
  readonly applications = signal<GroupJoinRequest[]>([]);
  readonly candidates = signal<GroupInviteCandidate[]>([]);
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

  private invitationBefore?: number;
  private applicationBefore?: number;
  private candidateAfterUserId?: number;
  private resolveSub?: Subscription;

  constructor() {
    const threadId = this.conversations.openThreadId();
    const hasUnreadApplications =
      threadId !== undefined &&
      this.users.groupJoinRequestHeads().has(threadId);
    if (hasUnreadApplications) {
      this.activeTab.set(1);
      this.markApplicationsRead();
      void this.loadRequests('APPLICATION', false);
    } else {
      void this.loadRequests('INVITATION', false);
    }
  }

  close(): void {
    this.nav.back();
  }

  setTab(index: number): void {
    this.activeTab.set(index);
    if (index === 1 && this.applications().length === 0) {
      this.markApplicationsRead();
      void this.loadRequests('APPLICATION', false);
    }
    if (index === 2 && this.candidates().length === 0)
      void this.loadCandidates(false);
  }

  search(): void {
    const query = this.searchText().trim();
    this.appliedSearch.set(query);
    this.invalidGroupAddress.set(/^!\S+@\S+$/.test(query));
    this.federatedAddress.set(null);
    void this.loadCandidates(false);
  }

  loadMoreRequests(kind: RequestListKind): void {
    void this.loadRequests(kind, true);
  }
  loadMoreCandidates(): void {
    void this.loadCandidates(true);
  }

  async handleApplication(requestId: string, accept: boolean): Promise<void> {
    const groupId = this.conversations.openThreadId();
    if (groupId === undefined || this.acting().has(requestId)) return;
    this.addActing(requestId);
    try {
      const res = await firstValueFrom(
        accept
          ? this.groups.acceptJoinRequest({ groupId, requestId })
          : this.groups.rejectJoinRequest({ groupId, requestId }),
      );
      if (res.code !== 0) return this.showBusinessError(res);
      this.applications.update((rows) =>
        rows.map((row) =>
          row.id === requestId
            ? applyGroupJoinRequestAction(row, accept ? 'ACCEPT' : 'REJECT')
            : row,
        ),
      );
    } catch {
      this.showNetworkError();
    } finally {
      this.removeActing(requestId);
    }
  }

  async revokeInvitation(requestId: string): Promise<void> {
    const groupId = this.conversations.openThreadId();
    if (groupId === undefined || this.acting().has(requestId)) return;
    const invitation = this.invitations().find((row) => row.id === requestId);
    this.addActing(requestId);
    try {
      const res = await firstValueFrom(
        this.groups.revokeInvitation({ groupId, requestId }),
      );
      if (res.code !== 0) return this.showBusinessError(res);
      this.invitations.update((rows) =>
        rows.map((row) =>
          row.id === requestId ? { ...row, status: 'REVOKED' } : row,
        ),
      );
      if (invitation)
        this.candidates.update((rows) =>
          rows.map((row) =>
            this.candidateKey(row) === this.candidateKey(invitation)
              ? { ...row, state: 'AVAILABLE' }
              : row,
          ),
        );
    } catch {
      this.showNetworkError();
    } finally {
      this.removeActing(requestId);
    }
  }

  candidateKey(candidate: { account: string; domain: string }): string {
    return `${candidate.account}@${candidate.domain}`;
  }

  async invite(candidate: GroupInviteCandidate): Promise<void> {
    const groupId = this.conversations.openThreadId();
    const key = this.candidateKey(candidate);
    if (
      groupId === undefined ||
      candidate.state !== 'AVAILABLE' ||
      this.inviting().has(key)
    )
      return;
    this.inviting.update((ids) => new Set(ids).add(key));
    try {
      const res = await firstValueFrom(
        this.groups.inviteUsers({
          groupId,
          users: [{ account: candidate.account, domain: candidate.domain }],
        }),
      );
      if (res.code !== 0) return this.showBusinessError(res);
      if (!res.data?.tasks.length || res.data.skipped.length) {
        this.toast.warn(this.transloco.translate('group.inviteUnavailable'));
        return;
      }
      this.candidates.update((rows) =>
        rows.map((row) =>
          this.candidateKey(row) === key ? { ...row, state: 'INVITED' } : row,
        ),
      );
      void this.loadRequests('INVITATION', false);
    } catch {
      this.showNetworkError();
    } finally {
      this.inviting.update((ids) => {
        const next = new Set(ids);
        next.delete(key);
        return next;
      });
    }
  }

  resolveFederated(): void {
    const address = this.federatedAddress();
    if (!address || this.resolvingFederated()) return;
    this.resolvingFederated.set(true);
    this.federationStage.set('DISCOVERING');
    this.resolveSub = this.users
      .resolveFederatedUser(address, (stage) => this.federationStage.set(stage))
      .subscribe({
        next: (result) => {
          if (result.user.isGroup) {
            this.invalidGroupAddress.set(true);
            return;
          }
          if (result.relationship !== 'FRIEND') {
            this.toast.warn(this.transloco.translate('group.friendRequired'));
            return;
          }
          const user = result.user;
          this.candidates.set([
            {
              userId: user.id,
              account: user.account,
              domain: user.domain || 'local',
              name: user.name,
              avatar: user.avatar,
              bio: user.bio ?? '',
              state: 'AVAILABLE',
            },
          ]);
          this.federatedAddress.set(null);
        },
        error: (error: unknown) => {
          this.resolvingFederated.set(false);
          const key =
            error instanceof FederatedResolveError &&
            error.reason === 'NOT_FOUND'
              ? 'group.noMatchingFriends'
              : 'errors.networkError';
          this.toast.warn(this.transloco.translate(key));
        },
        complete: () => this.resolvingFederated.set(false),
      });
  }

  requestStatusKey(status: GroupJoinRequest['status']): string {
    if (status === 'ACCEPTED') return 'group.invitationAccepted';
    if (status === 'REVOKED') return 'group.invitationRevoked';
    if (status === 'EXPIRED') return 'group.invitationExpired';
    return 'group.invitationPending';
  }

  candidateActionKey(candidate: GroupInviteCandidate): string {
    if (this.inviting().has(this.candidateKey(candidate)))
      return 'group.inviting';
    if (candidate.state === 'MEMBER') return 'group.alreadyMember';
    if (candidate.state === 'INVITED') return 'group.invitedStatus';
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
        mergeGroupJoinRequestPage(append ? rows : [], res.data!.data),
      );
      if (kind === 'INVITATION') {
        this.invitationBefore = res.data.before ?? undefined;
        this.invitationsHasMore.set(res.data.hasMore);
      } else {
        this.applicationBefore = res.data.before ?? undefined;
        this.applicationsHasMore.set(res.data.hasMore);
      }
    } catch {
      this.showNetworkError();
    } finally {
      loading.set(false);
    }
  }

  private async loadCandidates(append: boolean): Promise<void> {
    const groupId = this.conversations.openThreadId();
    if (groupId === undefined || this.loadingCandidates()) return;
    this.loadingCandidates.set(true);
    try {
      const res = await firstValueFrom(
        this.groups.queryInviteCandidates({
          groupId,
          afterUserId: append ? this.candidateAfterUserId : undefined,
          search: this.appliedSearch() || undefined,
          take: 20,
        }),
      );
      if (res.code !== 0 || !res.data) return this.showBusinessError(res);
      this.candidates.update((rows) =>
        append ? [...rows, ...res.data!.data] : res.data!.data,
      );
      this.candidateAfterUserId = res.data.afterUserId ?? undefined;
      this.candidatesHasMore.set(res.data.hasMore);
      if (!append && res.data.data.length === 0) this.prepareExactFallback();
    } catch {
      this.showNetworkError();
    } finally {
      this.loadingCandidates.set(false);
    }
  }

  private prepareExactFallback(): void {
    if (this.invalidGroupAddress()) return;
    const match = /^([^@\s]+)@([^@\s]+)$/.exec(this.appliedSearch());
    if (match)
      this.federatedAddress.set({ account: match[1], domain: match[2] });
  }

  private markApplicationsRead(): void {
    const threadId = this.conversations.openThreadId();
    const head =
      threadId === undefined
        ? undefined
        : this.users.groupJoinRequestHeads().get(threadId);
    if (threadId === undefined || !head) return;
    this.users.markGroupJoinRequestsRead(threadId);
    this.groups
      .markJoinRequestsRead({
        groupId: threadId,
        readFeedId: head.latestFeedId,
      })
      .subscribe();
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
