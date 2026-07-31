import { Component, computed, inject, input, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ConversationListService } from '../../services/conversation-list.service';
import {
  displayThreadName,
  type ConversationItem,
} from '../../services/model';
import { RouteService } from '../../services/route.service';
import { UserService } from '../../services/user.service';
import {
  conversationAvatarIdentityId,
  conversationAvatarSrc,
  conversationAvatarType,
} from '../user-avatar/conversation-avatar.util';
import { UserAvatarComponent } from '../user-avatar/user-avatar.component';
import {
  ForwardMessageCardComponent,
  type ForwardMessageItem,
  type ForwardRecordKind,
} from '../forward-message-card/forward-message-card.component';
import { ThreadSearchInputComponent } from '../thread-search-input/thread-search-input.component';

export interface ForwardDialogResult {
  readonly threadIds: readonly number[];
  readonly messages: readonly ForwardMessageItem[];
}

@Component({
  selector: 'app-forward-dialog',
  standalone: true,
  imports: [
    ForwardMessageCardComponent,
    ThreadSearchInputComponent,
    TranslocoPipe,
    UserAvatarComponent,
  ],
  templateUrl: './forward-dialog.component.html',
  styleUrl: './forward-dialog.component.scss',
})
export class ForwardDialogComponent {
  readonly messages = input.required<readonly ForwardMessageItem[]>();
  readonly recordKind = input<ForwardRecordKind>('chat');
  readonly searchText = signal('');
  readonly selectedThreadIds = signal<ReadonlySet<number>>(new Set());
  readonly recentThreadIds = signal<readonly number[]>([]);
  private readonly conversations = inject(ConversationListService);
  private readonly route = inject(RouteService);
  private readonly user = inject(UserService);

  readonly filteredConversations = computed(() => {
    const query = this.searchText().trim().toLocaleLowerCase();
    const items = this.conversations.items();
    if (!query) return items;
    return items.filter((item) =>
      displayThreadName(item).toLocaleLowerCase().includes(query),
    );
  });
  readonly recentConversations = computed(() => {
    const byId = new Map(
      this.conversations.items().map((item) => [item.threadId, item]),
    );
    return this.recentThreadIds()
      .map((id) => byId.get(id))
      .filter((item): item is ConversationItem => item !== undefined)
      .slice(0, 6);
  });

  readonly selectedCount = computed(() => this.selectedThreadIds().size);
  readonly displayName = displayThreadName;
  readonly avatarType = conversationAvatarType;
  readonly avatarIdentityId = conversationAvatarIdentityId;
  readonly avatarSrc = conversationAvatarSrc;

  constructor() {
    this.recentThreadIds.set(this.readRecentThreadIds());
  }

  setSearchText(value: string): void {
    this.searchText.set(value);
  }

  toggleConversation(item: ConversationItem): void {
    const next = new Set(this.selectedThreadIds());
    if (next.has(item.threadId)) next.delete(item.threadId);
    else next.add(item.threadId);
    this.selectedThreadIds.set(next);
  }

  close(): void {
    this.route.closeDlg();
  }

  confirm(): void {
    if (this.selectedCount() === 0) return;
    this.rememberRecentThreadIds([...this.selectedThreadIds()]);
    this.route.closeDlg({
      threadIds: [...this.selectedThreadIds()],
      messages: this.messages(),
    } satisfies ForwardDialogResult);
  }

  private readRecentThreadIds(): number[] {
    try {
      const value = JSON.parse(
        localStorage.getItem(this.recentStorageKey()) ?? '[]',
      );
      return Array.isArray(value)
        ? value.filter((id): id is number => Number.isInteger(id)).slice(0, 12)
        : [];
    } catch {
      return [];
    }
  }

  private rememberRecentThreadIds(threadIds: readonly number[]): void {
    const next = [
      ...threadIds,
      ...this.recentThreadIds().filter((id) => !threadIds.includes(id)),
    ].slice(0, 12);
    this.recentThreadIds.set(next);
    try {
      localStorage.setItem(this.recentStorageKey(), JSON.stringify(next));
    } catch {
      // Storage is a progressive enhancement; forwarding itself must still work.
    }
  }

  private recentStorageKey(): string {
    return `forward-recent:${this.user.sessionProfile()?.id ?? 'anonymous'}`;
  }
}
