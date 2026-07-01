import { Component, input, signal, computed, EventEmitter, Output, inject, OnInit } from '@angular/core';
import { NgClass } from '@angular/common';
import { RouteService, PopupType } from '../../services/route.service'
import { ConversationListService, ConversationLoadStatus } from '../../services/conversation-list.service'
import { ConversationItem } from '../../services/model'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { EmptyStateComponent } from '../empty-state/empty-state.component';
import { ChatFolder, inFolder } from '../../services/folder.service'
import { formatListTime } from '../message-cards/date-format'

/**
 * Conversation list view. A thin view over the shared ConversationListService (the client-side source
 * of truth, also driven by mark-read and realtime SSE). Folder + local-search filtering stay here as
 * computeds over the shared items; the active row is the store's openThreadId.
 */
@Component({
    selector: 'app-thread-list',
    imports: [UserAvatarComponent, NgClass, EmptyStateComponent],
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

  /** 有搜索词但过滤后无结果 →「搜索无结果」态（区别于真空态，不带 CTA） */
  readonly isSearchEmpty = computed(() =>
    this.searchText().trim().length > 0 && this.filteredThreadList().length === 0
  )

  @Output() onSelect = new EventEmitter<ConversationItem>()

  /** Short label for a thread's last message (a group sender-name prefix is a Phase-4 refinement). */
  previewText(t: ConversationItem): string {
    return t.lastMessagePreview ?? 'No messages yet'
  }

  fmtTime = formatListTime

  genThreadList() {
    this.convList.load()
  }

  /** 真空态 CTA：打开好友请求弹窗（与 icon-rail 同路径） */
  openFriendRequests() {
    this.routeService.popupDlg(PopupType.FRIEND_REQUESTS)
  }

  onUsrTrdClick(userMsgTrd: ConversationItem) {
    this.onSelect.emit(userMsgTrd)
  }

  ngOnInit() {
    // Load only if we don't already have data (the store is shared across layout switches).
    if (this.status() === 'LOADING' && this.items().length === 0) this.convList.load()
  }
}
