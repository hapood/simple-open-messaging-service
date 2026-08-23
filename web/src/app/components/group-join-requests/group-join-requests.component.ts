import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import {
  GroupService,
  type GroupJoinRequest,
} from '../../services/group.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { PageHeaderComponent } from '../page-header/page-header.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { ToastService } from '../../services/toast.service';
import { translateBizResult } from '../../services/biz-code';
import { UserService } from '../../services/user.service';

@Component({
  selector: 'app-group-join-requests',
  imports: [
    MatButtonModule,
    PageHeaderComponent,
    TranslocoPipe,
    UserAvatarComponent,
  ],
  templateUrl: './group-join-requests.component.html',
  styleUrl: './group-join-requests.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupJoinRequestsComponent {
  readonly UserAvatarType = UserAvatarType;
  private readonly groups = inject(GroupService);
  private readonly conversations = inject(ConversationListService);
  private readonly users = inject(UserService);
  private readonly nav = inject(NavStateMachineService);
  private readonly toast = inject(ToastService);
  private readonly transloco = inject(TranslocoService);

  readonly requests = signal<GroupJoinRequest[]>([]);
  readonly loading = signal(true);
  readonly loadingMore = signal(false);
  readonly hasMore = signal(false);
  readonly acting = signal<ReadonlySet<string>>(new Set());
  private before?: string;

  constructor() {
    const threadId = this.conversations.openThreadId();
    const head =
      threadId === undefined
        ? undefined
        : this.users.groupJoinRequestHeads().get(threadId);
    if (threadId !== undefined && head) {
      this.users.markGroupJoinRequestsRead(threadId);
      this.groups
        .markJoinRequestsRead({
          groupId: threadId,
          readRequestId: head.latestRequestId,
        })
        .subscribe();
    }
    void this.load(false);
  }

  close(): void {
    this.nav.closeAside();
  }

  loadMore(): void {
    if (this.hasMore() && !this.loadingMore()) void this.load(true);
  }

  async act(requestId: string, accept: boolean): Promise<void> {
    const groupId = this.conversations.openThreadId();
    if (groupId === undefined || this.acting().has(requestId)) return;
    this.acting.update((ids) => new Set(ids).add(requestId));
    try {
      const res = await firstValueFrom(
        accept
          ? this.groups.acceptJoinRequest({ groupId, requestId })
          : this.groups.rejectJoinRequest({ groupId, requestId }),
      );
      if (res.code !== 0) {
        this.toast.warn(translateBizResult(res, this.transloco));
        return;
      }
      this.requests.update((rows) =>
        rows.filter((row) => row.id !== requestId),
      );
    } catch {
      this.toast.warn(this.transloco.translate('errors.networkError'));
    } finally {
      this.acting.update((ids) => {
        const next = new Set(ids);
        next.delete(requestId);
        return next;
      });
    }
  }

  private async load(append: boolean): Promise<void> {
    const groupId = this.conversations.openThreadId();
    if (groupId === undefined) return;
    append ? this.loadingMore.set(true) : this.loading.set(true);
    try {
      const res = await firstValueFrom(
        this.groups.queryJoinRequests({
          groupId,
          before: append ? this.before : undefined,
          take: 20,
        }),
      );
      if (res.code !== 0 || !res.data) {
        this.toast.warn(translateBizResult(res, this.transloco));
        return;
      }
      this.requests.update((rows) =>
        append ? [...rows, ...res.data!.data] : res.data!.data,
      );
      this.before = res.data.before ?? undefined;
      this.hasMore.set(res.data.hasMore);
    } catch {
      this.toast.warn(this.transloco.translate('errors.networkError'));
    } finally {
      this.loading.set(false);
      this.loadingMore.set(false);
    }
  }
}
