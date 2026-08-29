import {
  Component,
  computed,
  effect,
  forwardRef,
  inject,
  input,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { ConversationListService } from '../../services/conversation-list.service';
import {
  displayThreadName,
  messageCreatorKey,
  type ConversationItem,
} from '../../services/model';
import { RouteService } from '../../services/route.service';
import { UserService } from '../../services/user.service';
import {
  conversationAvatarIdentityId,
  conversationAvatarAccount,
  conversationAvatarDomain,
  conversationAvatarSrc,
  conversationAvatarType,
} from '../user-avatar/conversation-avatar.util';
import { UserAvatarComponent } from '../user-avatar/user-avatar.component';
import { UserAvatarType } from '../user-avatar/model';
import {
  ForwardMessageCardComponent,
  type ForwardMessageItem,
  type ForwardRecordKind,
} from '../forward-message-card/forward-message-card.component';
import { ThreadSearchInputComponent } from '../thread-search-input/thread-search-input.component';
import { TextRowComponent } from '../message-cards/text-row/text-row.component';
import { MediaRowComponent } from '../message-cards/media-row/media-row.component';
import { FileRowComponent } from '../message-cards/file-row/file-row.component';
import { LinkRowComponent } from '../message-cards/link-row/link-row.component';
import { CallRowComponent } from '../message-cards/call-row/call-row.component';
import { ForwardRowComponent } from '../message-cards/forward-row/forward-row.component';
import { ContactCardRowComponent } from '../message-cards/contact-card-row/contact-card-row.component';
import { LinkCardService } from '../../services/link-card.service';
import {
  LinkCardGenerationService,
  type LinkCardContent,
} from '../../services/link-card-generation.service';
import type { ChatMsgData } from '../message-cards/chat-item';
import { MESSAGE_THREAD_ADAPTER } from '../message-thread/message-thread-adapter';
import { AppIconType, IconComponent } from '../icon/icon.component';
import { PageHeaderComponent } from '../page-header/page-header.component';

export type ForwardMode = 'DIRECT' | 'HISTORY';
export type ForwardDialogPurpose = 'FORWARD' | 'CHAT_CARD' | 'NATIVE_SHARE';

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
    // TextRowComponent opens dialogs through RouteService. RouteService also registers this
    // forwarding dialog, so defer resolving the row until the module cycle has initialized.
    forwardRef(() => TextRowComponent),
    MediaRowComponent,
    FileRowComponent,
    LinkRowComponent,
    CallRowComponent,
    ForwardRowComponent,
    ContactCardRowComponent,
    IconComponent,
    PageHeaderComponent,
  ],
  templateUrl: './forward-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './forward-dialog.component.scss',
})
export class ForwardDialogComponent {
  readonly AppIconType = AppIconType;
  readonly UserAvatarType = UserAvatarType;
  readonly messages = input<readonly ForwardMessageItem[]>([]);
  readonly recordKind = input<ForwardRecordKind>('chat');
  readonly mode = input<ForwardMode>('HISTORY');
  readonly purpose = input<ForwardDialogPurpose>('FORWARD');
  readonly sharedText = input('');
  readonly searchText = signal('');
  readonly selectedThreadIds = signal<ReadonlySet<number>>(new Set());
  readonly recentThreadIds = signal<readonly number[]>([]);
  private readonly conversations = inject(ConversationListService);
  private readonly threadAdapter = inject(MESSAGE_THREAD_ADAPTER);
  private readonly route = inject(RouteService);
  private readonly user = inject(UserService);
  private readonly linkCards = inject(LinkCardService);
  private readonly generations = inject(LinkCardGenerationService);
  private readonly transloco = inject(TranslocoService);
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
    const items = this.availableConversations();
    if (!query) return items;
    return items.filter((item) =>
      displayThreadName(item).toLocaleLowerCase().includes(query),
    );
  });
  readonly recentConversations = computed(() => {
    const byId = new Map(
      this.availableConversations().map((item) => [item.threadId, item]),
    );
    return this.recentThreadIds()
      .map((id) => byId.get(id))
      .filter((item): item is ConversationItem => item !== undefined)
      .slice(0, 6);
  });

  readonly selectedCount = computed(() => this.selectedThreadIds().size);
  readonly selectedConversations = computed(() => {
    const selected = this.selectedThreadIds();
    return this.availableConversations().filter((item) =>
      selected.has(item.threadId),
    );
  });
  readonly displayName = displayThreadName;
  readonly avatarType = conversationAvatarType;
  readonly avatarIdentityId = conversationAvatarIdentityId;
  readonly avatarAccount = conversationAvatarAccount;
  readonly avatarDomain = conversationAvatarDomain;
  readonly avatarSrc = conversationAvatarSrc;
  readonly directPreviewMessage = computed<ChatMsgData | null>(() => {
    const original = this.messages()[0]?.original;
    if (!original) return null;
    if (original.type === 'system') return original;
    const self = this.user.sessionProfile();
    if (!self) return null;
    return {
      ...original,
      creator: messageCreatorKey(
        { account: self.account, domain: 'local', namespaceId: 0 },
        'local',
      ),
      isSelf: true,
      name: self?.name || self?.account || original.name,
      avatar: self?.avatar || undefined,
      avatarIdentityId: messageCreatorKey(
        { account: self.account, domain: 'local', namespaceId: 0 },
        'local',
      ),
      avatarAccount: self?.account,
      avatarDomain: self?.domain,
      quote: undefined,
    };
  });
  readonly remainingDirectMessageCount = computed(() =>
    Math.max(0, this.messages().length - 1),
  );
  readonly selfProfile = this.user.sessionProfile.asReadonly();

  readonly effectiveForwardMode = computed(() =>
    this.purpose() === 'CHAT_CARD' ? 'DIRECT' : this.mode(),
  );

  private readonly availableConversations = computed(
    () => this.threadAdapter.forwardTargets() ?? this.conversations.items(),
  );

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

  confirm(mode: ForwardMode = this.effectiveForwardMode()): void {
    if (!this.canConfirm()) return;
    this.rememberRecentThreadIds([...this.selectedThreadIds()]);
    const generation = this.generation();
    this.route.closeDlg({
      threadIds: [...this.selectedThreadIds()],
      messages: this.messages(),
      mode,
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
      creator: this.selfCreatorKey(),
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

  private selfCreatorKey(): string {
    const self = this.user.sessionProfile();
    if (!self) throw new Error('session profile is required to forward');
    return messageCreatorKey(
      { account: self.account, domain: 'local', namespaceId: 0 },
      'local',
    );
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
