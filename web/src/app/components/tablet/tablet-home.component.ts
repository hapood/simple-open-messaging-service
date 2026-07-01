import { Component, signal, viewChild } from '@angular/core';
import { ConversationItem } from '../../services/model';
import { HomeHeaderComponent } from '../home-header/home-header.component';
import { ChatListPaneComponent } from '../desktop/chat-list-pane/chat-list-pane.component';
import { ChatPaneComponent } from '../desktop/chat-pane/chat-pane.component';
import { NavDrawerComponent } from '../nav-drawer/nav-drawer.component';
import { RootPopupComponent } from '../root-popup/root-popup.component';

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
  readonly selectedThread = signal<ConversationItem | undefined>(undefined)
  private readonly chatListPane = viewChild(ChatListPaneComponent)

  onThreadSelect(thread: ConversationItem) {
    this.selectedThread.set(thread)
  }

  refreshList() {
    this.chatListPane()?.refresh()
  }
}
