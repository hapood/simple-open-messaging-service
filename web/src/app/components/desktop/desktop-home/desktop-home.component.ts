import { Component, inject, signal, viewChild } from '@angular/core';
import { ConversationItem } from '../../../services/model';
import { IconRailComponent } from '../icon-rail/icon-rail.component';
import { ChatListPaneComponent } from '../chat-list-pane/chat-list-pane.component';
import { ChatPaneComponent } from '../chat-pane/chat-pane.component';
import { InfoPaneComponent } from '../info-pane/info-pane.component';
import { RootPopupComponent } from '../../root-popup/root-popup.component';
import { InfoPanelService } from '../../../services/info-panel.service';
import { ConversationListService } from '../../../services/conversation-list.service';

const LIST_WIDTH_KEY = 'soms.desktop.listWidth'
const MIN_LIST = 280, MAX_LIST = 480, DEFAULT_LIST = 360

/**
 * Telegram-style desktop shell: icon-rail | chat-list-pane | chat-pane | (info).
 * Thread selection is INLINE here (sets selectedThread) rather than a popup.
 * The right info panel is shared state (InfoPanelService) toggled from the
 * nested message-header. The chat-list width is drag-resizable and persisted.
 */
@Component({
  selector: 'app-desktop-home',
  imports: [IconRailComponent, ChatListPaneComponent, ChatPaneComponent, InfoPaneComponent, RootPopupComponent],
  templateUrl: './desktop-home.component.html',
  styleUrl: './desktop-home.component.scss'
})
export class DesktopHomeComponent {
  protected readonly infoPanel = inject(InfoPanelService)
  private readonly convList = inject(ConversationListService)
  readonly infoThread = this.infoPanel.thread

  readonly selectedThread = signal<ConversationItem | undefined>(undefined)
  /** chat-list width, persisted across sessions */
  readonly listWidth = signal<number>(this.readListWidth())
  private readonly chatListPane = viewChild(ChatListPaneComponent)

  onThreadSelect(thread: ConversationItem) {
    this.selectedThread.set(thread)
    // Mark the thread open (fires mark-read + clears its unread badge in the shared list).
    this.convList.open(thread.threadId)
    // if the info panel is open, follow the newly selected thread
    if (this.infoThread()) this.infoPanel.open(thread)
  }

  refreshList() {
    this.chatListPane()?.refresh()
  }

  // --- resizable chat-list pane ---
  startResize(event: MouseEvent) {
    event.preventDefault()
    const startX = event.clientX
    const startW = this.listWidth()
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(MAX_LIST, Math.max(MIN_LIST, startW + (ev.clientX - startX)))
      this.listWidth.set(w)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      this.saveListWidth(this.listWidth())
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  resetWidth() {
    this.listWidth.set(DEFAULT_LIST)
    this.saveListWidth(DEFAULT_LIST)
  }

  private readListWidth(): number {
    if (typeof localStorage === 'undefined') return DEFAULT_LIST
    const raw = localStorage.getItem(LIST_WIDTH_KEY)
    const n = raw ? parseInt(raw, 10) : DEFAULT_LIST
    return Number.isFinite(n) ? Math.min(MAX_LIST, Math.max(MIN_LIST, n)) : DEFAULT_LIST
  }

  private saveListWidth(w: number) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LIST_WIDTH_KEY, String(w))
  }
}
