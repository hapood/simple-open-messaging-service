import { AsyncPipe } from '@angular/common';
import {
  CdkFixedSizeVirtualScroll,
  CdkVirtualForOf,
  CdkVirtualScrollViewport,
} from '@angular/cdk/scrolling';
import { NamespaceDomainPipe } from '../../pipes/namespace-domain.pipe';
import {
  Component,
  input,
  computed,
  EventEmitter,
  Output,
  inject,
  OnInit,
  afterRenderEffect,
  effect,
  DestroyRef,
  signal,
  viewChild,
  viewChildren,
  untracked,
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
import { UserAvatarType } from '../user-avatar/model';
import {
  conversationAvatarType,
  conversationAvatarAccount,
  conversationAvatarNamespaceId,
} from '../user-avatar/conversation-avatar.util';
import { conversationAvatarProfile } from '../../services/avatar-profile-ref';
import { SendingTaskPresentation } from '../../services/sending-task-presentation.service';
import { EmptyStateComponent } from '../empty-state/empty-state.component';
import { LanguageService } from '../../services/language.service';
import { formatListTime } from '../message-cards/date-format';
import { ThreadListItemComponent } from './thread-list-item.component';
import { UnreadPresentation } from '../../services/unread-presentation.service';
import { ComposerDraftService } from '../../services/composer-draft.service';
import { hasUnreadGroupJoinRequests } from '../../services/group-join-request-state';

const THREAD_ROW_HEIGHT = 72;

/**
 * Conversation list view. A thin view over the shared ConversationListService (the client-side source
 * of truth, also driven by mark-read and realtime SSE). Folder + local-search filtering stay here as
 * computeds over the shared items; the active row is the store's activeThreadId.
 */
@Component({
  selector: 'app-thread-list',
  imports: [
    NamespaceDomainPipe,
    AsyncPipe,
    EmptyStateComponent,
    TranslocoPipe,
    ThreadListItemComponent,
    CdkVirtualScrollViewport,
    CdkVirtualForOf,
    CdkFixedSizeVirtualScroll,
  ],
  templateUrl: './thread-list.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './thread-list.component.scss',
})
export class ThreadListComponent implements OnInit {
  readonly sendingTasks = inject(SendingTaskPresentation);
  readonly UserAvatarType = UserAvatarType;
  /** local name search; '' = no filter. */
  readonly searchText = input('');

  private readonly routeService = inject(RouteService);
  private readonly convList = inject(ConversationListService);
  private readonly userService = inject(UserService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  private readonly viewport = viewChild(CdkVirtualScrollViewport);
  private readonly rows = viewChildren(ThreadListItemComponent);
  readonly rowHeight = THREAD_ROW_HEIGHT;
  readonly trackThread = (_index: number, thread: ConversationItem) =>
    thread.threadId;
  readonly composerDrafts = inject(ComposerDraftService);
  private readonly unreadPresentation = inject(UnreadPresentation);
  private previousItems: ConversationItem[] = [];
  private readonly heldPins = signal(new Map<number, number>());
  private readonly pinTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly pendingFocus = signal<number | null>(null);
  private readonly renderedRange = signal({ start: 0, end: 0 });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      for (const timer of this.pinTimers.values()) clearTimeout(timer);
    });
    effect(() => {
      const items = this.items();
      const visibleIds = new Set(
        Array.from(
          untracked(() => this.viewport())?.elementRef.nativeElement.querySelectorAll<HTMLElement>('[data-thread-id]') ?? [],
          (element) => Number(element.dataset['threadId']),
        ),
      );
      const currentById = new Map(items.map((item) => [item.threadId, item]));
      const originalHeld = untracked(this.heldPins);
      const held = new Map(originalHeld);
      // A second unpin must retain its displayed slot, not its index in the
      // canonical order that already moved earlier, still-exiting pins.
      const previousPresentation = this.withPinHolds(
        this.previousItems,
        originalHeld,
      );
      for (const [index, previous] of previousPresentation.entries()) {
        const current = currentById.get(previous.threadId);
        if (
          previous.pinned &&
          current &&
          !current.pinned &&
          visibleIds.has(current.threadId) &&
          !matchMedia('(prefers-reduced-motion: reduce)').matches
        ) {
          held.set(current.threadId, index);
          clearTimeout(this.pinTimers.get(current.threadId));
          // transitionend releases early; this also covers unmount and reduced motion.
          this.pinTimers.set(
            current.threadId,
            setTimeout(() => this.releasePin(current.threadId), 200),
          );
        }
      }
      for (const id of held.keys()) {
        if (!currentById.has(id) || currentById.get(id)?.pinned) {
          held.delete(id);
          clearTimeout(this.pinTimers.get(id));
          this.pinTimers.delete(id);
        }
      }
      this.previousItems = items;
      if (
        held.size !== originalHeld.size ||
        [...held].some(([id, index]) => originalHeld.get(id) !== index)
      )
        this.heldPins.set(held);
    });
    afterRenderEffect(() => {
      this.searchText();
      this.viewport()?.scrollToIndex(0);
      this.pendingFocus.set(null);
    });
    afterRenderEffect((onCleanup) => {
      const viewport = this.viewport();
      if (!viewport) return;
      // CDK observes window resize; panel resize and hidden-to-visible layout
      // changes also need a viewport check. CDK owns all range geometry.
      const observer = new ResizeObserver(() => viewport.checkViewportSize());
      observer.observe(viewport.elementRef.nativeElement);
      const subscription = viewport.renderedRangeStream.subscribe((range) =>
        this.renderedRange.set(range),
      );
      this.renderedRange.set(viewport.getRenderedRange());
      onCleanup(() => {
        observer.disconnect();
        subscription.unsubscribe();
      });
    });
    // Scroll events update CDK's range asynchronously. Keep the request until
    // that range is committed, rather than consuming it on the first render.
    afterRenderEffect(() => {
      const focus = this.pendingFocus();
      if (focus === null) return;
      const index = this.rowIndices().get(focus);
      if (index === undefined) {
        this.pendingFocus.set(null);
        return;
      }
      const range = this.renderedRange();
      this.rows();
      if (index < range.start || index >= range.end) return;
      const row = this.viewport()?.elementRef.nativeElement
        .querySelector<HTMLElement>(`[data-thread-id="${focus}"]`);
      if (row) {
        row.focus({ preventScroll: true });
        this.pendingFocus.set(null);
      }
    });
  }

  readonly items = this.convList.items;
  readonly status = this.convList.status;
  readonly errorMsg = this.convList.error;
  readonly activeThreadId = this.convList.activeThreadId;
  /** exposes the enum to the template's @switch */
  readonly LoadStatus: typeof ConversationLoadStatus = ConversationLoadStatus;

  /** View model after applying the local search filter. */
  readonly filteredThreadList = computed(() => {
    const q = this.searchText().trim().toLowerCase();
    const items = this.withPinHolds(this.items(), this.heldPins());
    return items.filter((t) => {
      if (q) {
        const name = displayThreadName(t);
        if (!name.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  });

  /** Apply transient holds identically when rendering and capturing the next exit. */
  private withPinHolds(
    canonical: readonly ConversationItem[],
    holds: ReadonlyMap<number, number>,
  ): ConversationItem[] {
    const items = [...canonical];
    for (const [id, index] of [...holds].sort((a, b) => a[1] - b[1])) {
      const current = items.findIndex((item) => item.threadId === id);
      if (current >= 0)
        items.splice(
          Math.min(index, items.length - 1),
          0,
          ...items.splice(current, 1),
        );
    }
    return items;
  }

  private readonly rowIndices = computed(
    () =>
      new Map(
        this.filteredThreadList().map((item, index) => [item.threadId, index]),
      ),
  );

  releasePin(threadId: number): void {
    clearTimeout(this.pinTimers.get(threadId));
    this.pinTimers.delete(threadId);
    this.heldPins.update((held) => {
      const next = new Map(held);
      next.delete(threadId);
      return next;
    });
  }

  presentedUnread(thread: ConversationItem): number {
    return this.activeThreadId() === thread.threadId &&
      this.unreadPresentation.suppresses(thread.threadId)
      ? 0
      : thread.unreadCount;
  }

  /** Arrow navigation can reach rows beyond the mounted window; native Enter,
   * Space and Tab behavior remains on the actual conversation buttons. */
  onRowKeydown(event: KeyboardEvent, threadId: number): void {
    const index = this.rowIndices().get(threadId);
    const viewport = this.viewport();
    const items = this.filteredThreadList();
    if (index === undefined || !viewport || !items.length) return;
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
    const height = viewport.getViewportSize();
    const current = viewport.measureScrollOffset();
    const offset =
      top < current
        ? top
        : top + THREAD_ROW_HEIGHT > current + height
          ? top + THREAD_ROW_HEIGHT - height
          : current;
    this.pendingFocus.set(items[target].threadId);
    viewport.scrollToOffset(offset);
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
    const unread = this.presentedUnread(t);
    if (unread > 0) {
      const count = unread >= 100 ? '99+' : unread;
      parts.push(this.transloco.translate('threadList.unreadCount', { count }));
    }
    if (unread > 0 && (t.mentionUnread?.length ?? 0) > 0) {
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
