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
  effect,
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
import { playFlipList } from '../../lib/flip-list';
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
  private readonly host = inject(ElementRef);
  readonly composerDrafts = inject(ComposerDraftService);
  private prevRects = new Map<string, DOMRect>();

  constructor() {
    // Animate insertions and feed-ordered moves after Angular commits the new list layout.
    effect(() => {
      this.convList.items();
      requestAnimationFrame(() => {
        const container = (
          this.host.nativeElement as HTMLElement | null
        )?.querySelector('.thread-list') as HTMLElement | null;
        if (!container) return;
        this.prevRects = playFlipList(container, this.prevRects);
      });
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
