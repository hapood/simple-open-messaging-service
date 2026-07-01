import { Component, viewChild, inject } from '@angular/core';
import { ConversationItem } from '../../../services/model'
import { HomeHeaderComponent } from '../../home-header/home-header.component';
import { ThreadListComponent } from '../../thread-list/thread-list.component';
import { NavDrawerComponent } from '../../nav-drawer/nav-drawer.component';
import { RootPopupComponent } from '../../root-popup/root-popup.component';
import { RouteService, PopupType } from '../../../services/route.service';
import { ConversationListService } from '../../../services/conversation-list.service';
@Component({
    selector: 'app-mobile-home',
    imports: [HomeHeaderComponent, ThreadListComponent, NavDrawerComponent, RootPopupComponent],
    templateUrl: './mobile-home.component.html',
    styleUrl: './mobile-home.component.scss'
})
export class MobileHomeComponent {
  readonly threadListCmp = viewChild(ThreadListComponent)
  private readonly routeService = inject(RouteService)
  private readonly convList = inject(ConversationListService)

  // forwarded to <app-nav-drawer> as the NewGroup dialog's onResult, so creating
  // a group refreshes the list
  refreshThreadList = () => {
    this.threadListCmp()?.genThreadList()
  }

  onThreadSelect(userMsgTrd: ConversationItem) {
    // Mark the thread open (mark-read + clear badge); clear it again when the chat popup closes,
    // so later incoming messages re-arm the badge.
    this.convList.open(userMsgTrd.threadId)
    this.routeService.popupDlg(
      PopupType.MSG_THREAD,
      { threadId: userMsgTrd.threadId, userMsgTrd },
      () => this.convList.close(),
    )
  }
}
