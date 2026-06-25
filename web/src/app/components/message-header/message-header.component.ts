import { Component, computed, inject, input } from '@angular/core';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { RouteService, PopupType } from '../../services/route.service';
import { UserMessageThread } from '../../services/model';
import { LayoutService } from '../../services/layout.service';
import { InfoPanelService } from '../../services/info-panel.service';
@Component({
    selector: 'app-message-header',
    imports: [IconComponent],
    templateUrl: './message-header.component.html',
    styleUrl: './message-header.component.scss'
})
export class MessageHeaderComponent {
  readonly AppIconType = AppIconType
  readonly userMsgTrd = input<UserMessageThread>()
  readonly title = computed(() => {
    const userMsgTrd = this.userMsgTrd()
    if (userMsgTrd !== undefined) {
      if (userMsgTrd.toObjType === 'P2P') {
        return userMsgTrd.userItem.uniqName
      } else if (userMsgTrd.toObjType === 'GROUP') {
        return userMsgTrd.groupItem.name
      }
    }
    return ''
  })
  // desktop renders the thread inline (no popup to close), so the back arrow
  // only makes sense on mobile, where it closes the MSG_THREAD popup.
  protected readonly isDesktop = inject(LayoutService).isDesktop
  private readonly infoPanel = inject(InfoPanelService)
  constructor(private routeService: RouteService) {

  }
  goBack() {
    this.routeService.closeDlg()
  }

  showThreadInfo() {
    const userMsgTrd = this.userMsgTrd()
    if (userMsgTrd !== undefined) {
      if (this.isDesktop()) {
        // desktop: GROUP shows members/invite, P2P shows profile — both in the side panel
        this.infoPanel.toggle(userMsgTrd)
      } else if (userMsgTrd.toObjType === 'GROUP') {
        this.routeService.popupDlg(PopupType.GROUP_INFO, { userMsgTrd })
      }
    }
  }
}
