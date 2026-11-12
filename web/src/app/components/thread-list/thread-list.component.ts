import { AsyncPipe } from '@angular/common';
import { NamespaceDomainPipe } from '../../pipes/namespace-domain.pipe';
import {
  Component,
  input,
  computed,
  EventEmitter,
  Output,
  inject,
  OnInit,
  ElementRef,
  afterRenderEffect,
  effect,
  DestroyRef,
  signal,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService, PopupType } from '../../services/route.service';
import {
  ConversationListService,
  ConversationLoadStatus,
} from '../../services/conversation-list.service';
import { UserService } from '../../services/user.service';
import { ConversationItem, displayThreadName } from '../../services/model';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import { UserAvatarType } from '../user-avatar/model';
import {
  conversationAvatarType,
  conversationAvatarAccount,
  conversationAvatarNamespaceId,
} from '../user-avatar/conversation-avatar.util';
import { conversationAvatarProfile } from '../../services/avatar-profile-ref';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { UserIdentityLabelComponent } from '../user-identity-label/user-identity-label.component';
import { EmptyStateComponent } from '../empty-state/empty-state.component';
import { LanguageService } from '../../services/language.service';
import { formatListTime } from '../message-cards/date-format';
import { FlipListAnimator, FlipListLayout } from '../../lib/flip-list';
import { THREAD_ROW_HEIGHT, threadListWindow } from './thread-list-window';
import { ComposerDraftService } from '../../services/composer-draft.service';
import { hasUnreadGroupJoinRequests } from '../../services/group-join-request-state';

/**
 * Conversation list view. A thin view over the shared ConversationListService (the client-side source
 * of truth, also driven by mark-read and realtime SSE). Folder + local-search filtering stay here as
 * computeds over the shared items; the active row is the store's openThreadId.
 */
@Component({
  selector: 'app-thread-list',
  imports: [
    DemandAvatarComponent,
    NamespaceDomainPipe,
    AsyncPipe,
    IconComponent,
    EmptyStateComponent,
    TranslocoPipe,
    UserIdentityLabelComponent,
  ],
  templateUrl: './thread-list.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './thread-list.component.scss',
})
export class ThreadListComponent implements OnInit {
  readonly UserAvatarType = UserAvatarType;
  /** exposes the icon enum to the template (mute indicator on muted threads). */
  readonly AppIconType = AppIconType;
  /** local name search; '' = no filter. */
  readonly searchText = input('');

  private readonly routeService = inject(RouteService);
  private readonly convList = inject(ConversationListService);
  private readonly userService = inject(UserService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  private readonly viewport =
    viewChild<ElementRef<HTMLElement>>('listViewport');
  readonly composerDrafts = inject(ComposerDraftService);
  private readonly listAnimator = new FlipListAnimator();
  private previousSearch = '';
  private readonly viewportHeight = signal(0);
  private readonly scrollState = signal({ search: '', top: 0 });
  private readonly pendingFocus = signal<number | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.listAnimator.destroy());
    effect(() => {
      this.scrollState.set({ search: this.searchText(), top: 0 });
    });
    afterRenderEffect((onCleanup) => {
      const container = this.viewport()?.nativeElement;
      if (!container) return;
      const measure = () => this.viewportHeight.set(container.clientHeight);
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(container);
      onCleanup(() => observer.disconnect());
    });
    // Angular commits the keyed window before both animation axes start. Scrolling
    // changes only the window, not the complete layout's identity or revisions.
    afterRenderEffect(() => {
      const container = this.viewport()?.nativeElement;
      const layout = this.animationLayout();
      const window = this.renderedWindow();
      const search = this.searchText();
      const status = this.status();
      if (
        search !== this.previousSearch ||
        status !== ConversationLoadStatus.READY
      )
        this.listAnimator.destroy();
      if (container) {
        // Clamp after shrinking/filtering as well as when resetting search.
        if (container.scrollTop !== window.scrollTop)
          container.scrollTop = window.scrollTop;
        if (this.scrollState().top !== window.scrollTop)
          this.scrollState.set({ search, top: window.scrollTop });
        if (status === ConversationLoadStatus.READY)
          this.listAnimator.play(container, layout);
        const focus = this.pendingFocus();
        if (focus !== null) {
          container
            .querySelector<HTMLElement>(`[data-flip-key="${focus}"]`)
            ?.focus({ preventScroll: true });
          this.pendingFocus.set(null);
        }
      }
      this.previousSearch = search;
    });
  }

  readonly items = this.convList.items;
  readonly status = this.convList.status;
  readonly errorMsg = this.convList.error;
  readonly openThreadId = this.convList.openThreadId;
  /** exposes the enum to the template's @switch */
  readonly LoadStatus: typeof ConversationLoadStatus = ConversationLoadStatus;

  /** View model after applying the local search filter. */
  readonly filteredThreadList = computed(() => {
    const q = this.searchText().trim().toLowerCase();
    return this.items().filter((t) => {
      if (q) {
        const name = displayThreadName(t);
        if (!name.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  });

  readonly renderedWindow = computed(() => {
    const scroll = this.scrollState();
    return threadListWindow(
      this.filteredThreadList().length,
      this.viewportHeight(),
      scroll.search === this.searchText() ? scroll.top : 0,
    );
  });

  readonly visibleThreadList = computed(() => {
    const window = this.renderedWindow();
    return this.filteredThreadList().slice(window.start, window.end);
  });

  // O(n) data-only work happens on list updates, never on scroll. DOM work and
  // visual snapshots remain bounded by the viewport plus its small buffer.
  private readonly animationLayout = computed<FlipListLayout>(
    () =>
      new Map(
        this.filteredThreadList().map((item, index) => [
          String(item.threadId),
          {
            top: index * THREAD_ROW_HEIGHT,
            revision: JSON.stringify([
              item.pinned,
              item.pinnedAt,
              item.threadFeedId,
              item.lastMessageAt,
            ]),
          },
        ]),
      ),
  );

  onViewportScroll(): void {
    const container = this.viewport()?.nativeElement;
    if (container)
      this.scrollState.set({
        search: this.searchText(),
        top: container.scrollTop,
      });
  }

  /** Arrow navigation can reach rows beyond the mounted window; native Enter,
   * Space and Tab behavior remains on the actual conversation buttons. */
  onRowKeydown(event: KeyboardEvent, threadId: number): void {
    const position = this.animationLayout().get(String(threadId));
    const container = this.viewport()?.nativeElement;
    const items = this.filteredThreadList();
    if (!position || !container || !items.length) return;
    const index = position.top / THREAD_ROW_HEIGHT;
    let target: number;
    switch (event.key) {
      case 'ArrowDown':
        target = Math.min(index + 1, items.length - 1);
        break;
      case 'ArrowUp':
        target = Math.max(index - 1, 0);
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const top = target * THREAD_ROW_HEIGHT;
    const height = Math.max(THREAD_ROW_HEIGHT, this.viewportHeight());
    const current = this.renderedWindow().scrollTop;
    const offset =
      top < current
        ? top
        : top + THREAD_ROW_HEIGHT > current + height
          ? top + THREAD_ROW_HEIGHT - height
          : current;
    container.scrollTop = offset;
    this.scrollState.set({ search: this.searchText(), top: offset });
    this.pendingFocus.set(items[target].threadId);
  }

  /** A search term is set but the filter yields nothing → "no search results" state (distinct from the true
   *  empty state; carries no CTA). */
  readonly isSearchEmpty = computed(
    () =>
      this.searchText().trim().length > 0 &&
      this.filteredThreadList().length === 0,
  );

  @Output() onSelect = new EventEmitter<ConversationItem>();

  /** Display name for a thread — alias overrides the real name. */
  displayName(t: ConversationItem): string {
    return displayThreadName(t);
  }

  /** Backend denormalizes `lastMessagePreview` as an English marker for non-text messages ("[Photo]",
   *  "[Group invite]", … — see backend derivePreview). Recognize that closed set here and translate it;
   *  real text previews pass through untouched. Reads the language signal so the row re-evaluates on a
   *  language switch. The "You:" prefix is shown for the sender's own messages (the missed-summary carries
   *  `creator`, not the sender's display name, so incoming messages show bare — no "Alice:" prefix). */
  private static readonly PREVIEW_MARKERS: Readonly<Record<string, string>> = {
    '[Photo]': 'chat.preview.photo',
    '[Message retracted]': 'chat.messageRetracted',
    '[Message removed by administrator]': 'chat.messageRemovedByAdmin',
    '[Group invite]': 'chat.preview.invite',
    '[Video]': 'chat.preview.video',
    '[File]': 'chat.preview.file',
    '[Voice message]': 'chat.preview.voice',
    '[File set]': 'chat.preview.fileGroup',
    '[System message]': 'chat.preview.system',
    '[Call]': 'call.record.unknown',
    '[Missed call]': 'call.record.missed',
    '[Call failed]': 'call.record.failed',
    '[Call unreachable]': 'call.record.unreachable',
    '[Call declined]': 'call.record.declined',
    '[Call cancelled]': 'call.record.cancelled',
    '[Contact]': 'contactCard.previewLabel',
    '[Chat history]': 'forward.previewLabel',
    '[聊天记录]': 'forward.previewLabel',
  };

  previewText(t: ConversationItem): string {
    this.language.lang();
    const draft = this.composerDrafts.get(t.threadId);
    if (draft)
      return this.transloco.translate('threadList.draftPreview', {
        text: draft.plainText.replace(/\s+/g, ' ').trim(),
      });
    const raw = t.lastMessagePreview;
    const marker = raw
      ? Object.keys(ThreadListComponent.PREVIEW_MARKERS).find(
          (candidate) => raw === candidate || raw.startsWith(`${candidate} `),
        )
      : undefined;
    const markerKey = marker
      ? ThreadListComponent.PREVIEW_MARKERS[marker]
      : undefined;
    const markerSuffix = marker && raw ? raw.slice(marker.length) : '';
    const base =
      (markerKey
        ? `${this.transloco.translate(markerKey)}${markerSuffix}`
        : raw) ?? '';
    if (
      !base ||
      t.lastMessageSenderAccount == null ||
      t.lastMessageSenderNamespaceId == null
    )
      return base;
    const self = this.userService.sessionProfile();
    if (
      self &&
      t.lastMessageSenderAccount === self.account &&
      t.lastMessageSenderNamespaceId === self.namespaceId
    )
      return this.transloco.translate('chat.youPrefix', { text: base }) ?? '';
    return base;
  }

  /** Conversation-list timestamp; reads the language signal so it re-evaluates on a language switch. */
  fmtTime = (ms: number | null | undefined): string => {
    this.language.lang();
    return formatListTime(ms, this.transloco);
  };

  previewTime(t: ConversationItem): number | null | undefined {
    const draft = this.composerDrafts.get(t.threadId);
    if (draft) return draft.updatedAt;
    return t.lastMessageAt;
  }

  hasUnreadJoinRequests(t: ConversationItem): boolean {
    return t.type === 'GROUP' && hasUnreadGroupJoinRequests(t);
  }

  // Conversation→avatar derivation lives in the shared conversation-avatar util (single source of truth,
  // shared with the empty-thread hero). These delegate to it so the logic is not duplicated across surfaces.
  avatarType(t: ConversationItem): UserAvatarType {
    return conversationAvatarType(t);
  }

  avatarAccount(t: ConversationItem): string {
    return conversationAvatarAccount(t);
  }

  readonly avatarProfile = conversationAvatarProfile;

  readonly avatarNamespaceId = conversationAvatarNamespaceId;

  /** One concise announcement for screen readers; visible badges/icons remain aria-hidden to avoid repetition. */
  accessibleLabel(t: ConversationItem, domain: string | null = null): string {
    const parts = [
      this.displayName(t),
      domain,
      t.blocked
        ? this.transloco.translate('threadList.blocked')
        : this.previewText(t),
      this.fmtTime(t.lastMessageAt),
    ];
    if (t.unreadCount > 0) {
      const count = t.unreadCount >= 100 ? '99+' : t.unreadCount;
      parts.push(this.transloco.translate('threadList.unreadCount', { count }));
    }
    if ((t.mentionUnread?.length ?? 0) > 0) {
      parts.push(this.transloco.translate('threadList.mentionedYou'));
    }
    if (this.hasUnreadJoinRequests(t))
      parts.push(this.transloco.translate('group.joinRequests'));
    if (t.muted && !t.blocked)
      parts.push(this.transloco.translate('threadList.muted'));
    if (t.pinned) parts.push(this.transloco.translate('threadList.pinned'));
    return parts.filter(Boolean).join(', ');
  }

  genThreadList() {
    this.convList.load();
  }

  /** True-empty-state CTA: open the friend-requests popup (same path as the icon rail). */
  openFriendRequests() {
    this.routeService.popupDlg(PopupType.FRIEND_REQUESTS, {
      initialTab: 'add',
    });
  }

  onUsrTrdClick(userMsgTrd: ConversationItem) {
    this.onSelect.emit(userMsgTrd);
  }

  ngOnInit() {
    // Load only if we don't already have data (the store is shared across layout switches).
    if (
      this.status() === ConversationLoadStatus.LOADING &&
      this.items().length === 0
    )
      this.convList.load();
  }
}
