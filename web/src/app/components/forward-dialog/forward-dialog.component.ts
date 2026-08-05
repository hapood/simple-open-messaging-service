import {
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ConversationListService } from '../../services/conversation-list.service';
import { displayThreadName, type ConversationItem } from '../../services/model';
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
import { TextRowComponent } from '../message-cards/text-row/text-row.component';
import { MediaRowComponent } from '../message-cards/media-row/media-row.component';
import { FileRowComponent } from '../message-cards/file-row/file-row.component';
import { InviteRowComponent } from '../message-cards/invite-row/invite-row.component';
import { LinkRowComponent } from '../message-cards/link-row/link-row.component';
import { CallRowComponent } from '../message-cards/call-row/call-row.component';
import { ForwardRowComponent } from '../message-cards/forward-row/forward-row.component';
import { LinkCardService } from '../../services/link-card.service';
import {
  LinkCardGenerationService,
  type LinkCardContent,
} from '../../services/link-card-generation.service';
import type { ChatMsgData } from '../message-cards/chat-item';

export type ForwardMode = 'DIRECT' | 'HISTORY';
export type ForwardDialogPurpose = 'FORWARD' | 'NATIVE_SHARE';

export interface ForwardDialogResult {
  readonly threadIds: readonly number[];
  readonly messages: readonly ForwardMessageItem[];
  readonly mode: ForwardMode;
  readonly nativeShare?:
    | { readonly kind: 'link'; readonly generationId: string }
    | { readonly kind: 'text'; readonly text: string };
}

@Component({
  selector: 'app-forward-dialog',
  standalone: true,
  imports: [
    ForwardMessageCardComponent,
    ThreadSearchInputComponent,
    TranslocoPipe,
    UserAvatarComponent,
    TextRowComponent,
    MediaRowComponent,
    FileRowComponent,
    InviteRowComponent,
    LinkRowComponent,
    CallRowComponent,
    ForwardRowComponent,
  ],
  templateUrl: './forward-dialog.component.html',
  styleUrl: './forward-dialog.component.scss',
})
export class ForwardDialogComponent {
  readonly messages = input<readonly ForwardMessageItem[]>([]);
  readonly recordKind = input<ForwardRecordKind>('chat');
  readonly mode = input<ForwardMode>('HISTORY');
  readonly purpose = input<ForwardDialogPurpose>('FORWARD');
  readonly sharedText = input('');
  readonly searchText = signal('');
  readonly selectedThreadIds = signal<ReadonlySet<number>>(new Set());
  readonly recentThreadIds = signal<readonly number[]>([]);
  private readonly conversations = inject(ConversationListService);
  private readonly route = inject(RouteService);
  private readonly user = inject(UserService);
  private readonly linkCards = inject(LinkCardService);
  private readonly generations = inject(LinkCardGenerationService);
  private readonly generationId = signal<string | null>(null);
  readonly shareMode = signal<'link' | 'text'>('link');
  readonly generationStarting = signal(false);
  private generationStartedFor = '';

  readonly sharedUrl = computed(() =>
    this.linkCards.firstUrl(this.sharedText()),
  );
  readonly generation = computed(() => {
    const id = this.generationId();
    return id ? this.generations.state(id)() : undefined;
  });
  readonly generationStatus = computed(() =>
    this.generationStarting()
      ? 'pending'
      : (this.generation()?.status ?? 'failed'),
  );
  readonly shareLinkMessage = computed<ChatMsgData | null>(() => {
    const content = this.generation()?.content;
    if (!content) return null;
    return this.previewLinkMessage(content);
  });
  readonly canRetryGeneration = computed(
    () => this.generationStatus() === 'failed' && Boolean(this.sharedUrl()),
  );
  readonly canConfirm = computed(() => {
    if (this.selectedCount() === 0) return false;
    if (this.purpose() !== 'NATIVE_SHARE') return true;
    if (this.shareMode() === 'text') return Boolean(this.sharedText().trim());
    return Boolean(
      this.generationStatus() === 'succeeded' && this.generation()?.content,
    );
  });

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
  readonly selectedConversations = computed(() => {
    const selected = this.selectedThreadIds();
    return this.conversations
      .items()
      .filter((item) => selected.has(item.threadId));
  });
  readonly displayName = displayThreadName;
  readonly avatarType = conversationAvatarType;
  readonly avatarIdentityId = conversationAvatarIdentityId;
  readonly avatarSrc = conversationAvatarSrc;
  readonly directMessage = computed(() => {
    const original = this.messages()[0]?.original;
    return original ? { ...original, isSelf: true, quote: undefined } : null;
  });

  constructor() {
    this.recentThreadIds.set(this.readRecentThreadIds());
    effect(() => {
      if (this.purpose() !== 'NATIVE_SHARE') return;
      const url = this.sharedUrl();
      if (!url) {
        this.shareMode.set('text');
        return;
      }
      if (this.generationStartedFor === url) return;
      this.generationStartedFor = url;
      void this.beginGeneration(url);
    });
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

  removeConversation(item: ConversationItem): void {
    const next = new Set(this.selectedThreadIds());
    next.delete(item.threadId);
    this.selectedThreadIds.set(next);
  }

  close(): void {
    this.route.closeDlg();
  }

  confirm(): void {
    if (!this.canConfirm()) return;
    this.rememberRecentThreadIds([...this.selectedThreadIds()]);
    const generation = this.generation();
    this.route.closeDlg({
      threadIds: [...this.selectedThreadIds()],
      messages: this.messages(),
      mode: this.mode(),
      ...(this.purpose() === 'NATIVE_SHARE'
        ? {
            nativeShare:
              this.shareMode() === 'link' && generation
                ? {
                    kind: 'link' as const,
                    generationId: generation.generationId,
                  }
                : { kind: 'text' as const, text: this.sharedText() },
          }
        : {}),
    } satisfies ForwardDialogResult);
  }

  retryGeneration(): void {
    const url = this.sharedUrl();
    if (!url || !this.canRetryGeneration()) return;
    void this.beginGeneration(url, this.generationId() ?? undefined);
  }

  useOriginalText(): void {
    if (this.sharedText().trim()) this.shareMode.set('text');
  }

  private async beginGeneration(
    url: string,
    generationId?: string,
  ): Promise<void> {
    this.shareMode.set('link');
    this.generationStarting.set(true);
    try {
      const state = await this.generations.begin(
        url,
        this.sharedText(),
        generationId,
      );
      this.generationId.set(state.generationId);
    } catch {
      if (!generationId) this.generationId.set(null);
    } finally {
      this.generationStarting.set(false);
    }
  }

  private previewLinkMessage(content: LinkCardContent): ChatMsgData {
    return {
      type: 'msg',
      msgId: 0,
      creator: this.user.sessionProfile()?.id ?? 0,
      isSelf: true,
      name: this.user.sessionProfile()?.account ?? '',
      text: JSON.stringify(content),
      time: '',
      contentType: 'LINK',
      images: null,
      file: null,
      createdAtMs: Date.now(),
    };
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
