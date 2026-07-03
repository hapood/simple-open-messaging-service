import { Component, signal, viewChild, inject, effect } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ConversationItem } from '../../services/model';
import { HomeHeaderComponent } from '../home-header/home-header.component';
import { ChatListPaneComponent } from '../desktop/chat-list-pane/chat-list-pane.component';
import { ChatPaneComponent } from '../desktop/chat-pane/chat-pane.component';
import { NavDrawerComponent } from '../nav-drawer/nav-drawer.component';
import { RootPopupComponent } from '../root-popup/root-popup.component';
import { ConversationListService } from '../../services/conversation-list.service';

/**
 * Tablet / landscape-large-phone shell: nav-drawer + [home-header + chat-list-pane |
 * chat-pane] + root-popup. Deliberately omits the desktop-only icon-rail / resizer /
 * info-pane. The left nav drawer (好友请求/新建群组/文件夹/登出) replaces the old
 * home-header dropdown; thread selection is INLINE (selectedThread → chat-pane).
 */
@Component({
  selector: 'app-tablet-home',
  imports: [HomeHeaderComponent, ChatListPaneComponent, ChatPaneComponent, NavDrawerComponent, RootPopupComponent],
  templateUrl: './tablet-home.component.html',
  styleUrl: './tablet-home.component.scss',
})
export class TabletHomeComponent {
  private readonly convList = inject(ConversationListService)
  readonly selectedThread = signal<ConversationItem | undefined>(undefined)
  private readonly chatListPane = viewChild(ChatListPaneComponent)

  constructor() {
    // Honor open-conversation intents from elsewhere (e.g. the invite card's "Open group" after
    // joining) by routing them through the same selection path as clicking the list.
    this.convList.openRequest$.pipe(takeUntilDestroyed()).subscribe((item) => this.onThreadSelect(item))

    // When the open thread is removed (unfriend / self-leave / kicked — all via removeThread, which clears
    // openThreadId), drop the inline selection so the chat pane doesn't keep rendering a deleted conversation.
    // Parity with desktop-home; on tablet openThreadId is only ever cleared by removal (no chat popup).
    effect(() => {
      if (this.convList.openThreadId() === undefined) this.selectedThread.set(undefined)
    })
  }

  onThreadSelect(thread: ConversationItem) {
    this.selectedThread.set(thread)
    this.convList.open(thread.threadId)
  }

  refreshList() {
    this.chatListPane()?.refresh()
  }
}
