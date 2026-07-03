import { Component, input, signal, computed, EventEmitter, Output, inject, OnInit } from '@angular/core';
import { NgClass } from '@angular/common';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService, PopupType } from '../../services/route.service'
import { ConversationListService, ConversationLoadStatus } from '../../services/conversation-list.service'
import { UserService } from '../../services/user.service'
import { ConversationItem } from '../../services/model'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { EmptyStateComponent } from '../empty-state/empty-state.component';
import { ChatFolder, inFolder } from '../../services/folder.service'
import { LanguageService } from '../../services/language.service'
import { formatListTime } from '../message-cards/date-format'

/**
 * Conversation list view. A thin view over the shared ConversationListService (the client-side source
 * of truth, also driven by mark-read and realtime SSE). Folder + local-search filtering stay here as
 * computeds over the shared items; the active row is the store's openThreadId.
 */
@Component({
    selector: 'app-thread-list',
    imports: [UserAvatarComponent, NgClass, EmptyStateComponent, TranslocoPipe],
    templateUrl: './thread-list.component.html',
    styleUrl: './thread-list.component.scss'
})
export class ThreadListComponent implements OnInit {
  readonly UserAvatarType = UserAvatarType
  /** active folder; undefined = no folder filter (show all) */
  readonly folder = input<ChatFolder | undefined>(undefined)
  /** local name search; '' = no filter. */
  readonly searchText = input('')

  private readonly routeService = inject(RouteService)
  private readonly convList = inject(ConversationListService)
  private readonly userService = inject(UserService)
  private readonly transloco = inject(TranslocoService)
  private readonly language = inject(LanguageService)

  readonly items = this.convList.items
  readonly status = this.convList.status
  readonly errorMsg = this.convList.error
  readonly openThreadId = this.convList.openThreadId
  /** exposes the enum to the template's @switch */
  readonly LoadStatus: typeof ConversationLoadStatus = ConversationLoadStatus

  /** view model after applying the folder + search filters. */
  readonly filteredThreadList = computed(() => {
    const folder = this.folder(), q = this.searchText().trim().toLowerCase()
    return this.items().filter(t => {
      if (folder && !inFolder(t, folder)) return false
      if (q) {
        const name = (t.type === 'P2P' ? t.peerUser?.uniqName : t.group?.name) ?? ''
        if (!name.toLowerCase().includes(q)) return false
      }
      return true
    })
  })

  /** A search term is set but the filter yields nothing → "no search results" state (distinct from the true
   *  empty state; carries no CTA). */
  readonly isSearchEmpty = computed(() =>
    this.searchText().trim().length > 0 && this.filteredThreadList().length === 0
  )

  @Output() onSelect = new EventEmitter<ConversationItem>()

  /**
   * Short label for a thread's last message. GROUP conversations prefix the sender ("Alice: hi" /
   * "You: hi") when the sender name is known; P2P conversations show the bare preview (the peer is
   * implied). Live NEW_MESSAGE frames can't resolve a group sender's name cheaply, so an incoming
   * group message shows bare until the next full reload re-hydrates lastMessageSenderName.
   */
  /**
   * The backend denormalizes `lastMessagePreview` as an English marker for non-text messages
   * ("[Photo]", "[Group invite]", … — see backend derivePreview). Recognize that closed set here and
   * translate it; real text previews pass through untouched. Reads the language signal so the row
   * re-evaluates on a language switch (the template also re-renders via its transloco bindings).
   */
  private static readonly PREVIEW_MARKERS: Readonly<Record<string, string>> = {
    '[Photo]': 'chat.preview.photo',
    '[Group invite]': 'chat.preview.invite',
    '[Video]': 'chat.preview.video',
    '[File]': 'chat.preview.file',
    '[Voice message]': 'chat.preview.voice',
  };

  previewText(t: ConversationItem): string {
    this.language.lang();
    const raw = t.lastMessagePreview;
    const markerKey = raw ? ThreadListComponent.PREVIEW_MARKERS[raw] : undefined;
    const base = (markerKey ? this.transloco.translate(markerKey) : raw)
      ?? this.transloco.translate('common.noMessagesYet') ?? '';
    if (t.type !== 'GROUP' || t.lastMessageSenderId == null) return base;
    if (t.lastMessageSenderId === this.userService.sessionProfile()?.id)
      return this.transloco.translate('chat.youPrefix', { text: base }) ?? '';
    return t.lastMessageSenderName ? `${t.lastMessageSenderName}: ${base}` : base;
  }

  /** Conversation-list timestamp; reads the language signal so it re-evaluates on a language switch. */
  fmtTime = (ms: number | null | undefined): string => {
    this.language.lang()
    return formatListTime(ms, this.transloco)
  }

  genThreadList() {
    this.convList.load()
  }

  /** True-empty-state CTA: open the friend-requests popup (same path as the icon rail). */
  openFriendRequests() {
    this.routeService.popupDlg(PopupType.FRIEND_REQUESTS)
  }

  onUsrTrdClick(userMsgTrd: ConversationItem) {
    this.onSelect.emit(userMsgTrd)
  }

  ngOnInit() {
    // Load only if we don't already have data (the store is shared across layout switches).
    if (this.status() === ConversationLoadStatus.LOADING && this.items().length === 0) this.convList.load()
  }
}
