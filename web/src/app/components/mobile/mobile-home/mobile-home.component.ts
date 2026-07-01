import { Component, signal, viewChild } from '@angular/core';
import { ConversationItem } from '../../../services/model'
import { HomeHeaderComponent } from '../../home-header/home-header.component';
import { ThreadListComponent } from '../../thread-list/thread-list.component';
import { NavDrawerComponent } from '../../nav-drawer/nav-drawer.component';
import { RootPopupComponent } from '../../root-popup/root-popup.component';
import { RouteService, PopupType } from '../../../services/route.service';
@Component({
    selector: 'app-mobile-home',
    imports: [HomeHeaderComponent, ThreadListComponent, NavDrawerComponent, RootPopupComponent],
    templateUrl: './mobile-home.component.html',
    styleUrl: './mobile-home.component.scss'
})
export class MobileHomeComponent {
  // kept for the thread-list [profile] binding (currently unused downstream)
  readonly profile = signal<undefined>(undefined)
  curUsrtrdId = signal<number | undefined>(undefined)
  readonly threadListCmp = viewChild(ThreadListComponent)

  constructor(private routeService: RouteService) { }

  // forwarded to <app-nav-drawer> as the NewGroup dialog's onResult, so creating
  // a group refreshes the list
  refreshThreadList = () => {
    this.threadListCmp()?.genThreadList()
  }

  onThreadSelect(userMsgTrd: ConversationItem) {
    this.routeService.popupDlg(PopupType.MSG_THREAD, { threadId: userMsgTrd.threadId, userMsgTrd })
  }
}
