import { Component, computed, input } from '@angular/core';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { RouteService, PopupType } from '../../services/route.service';
import { UserMessageThread } from '../../services/model';
@Component({
  selector: 'app-message-header',
  standalone: true,
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
  constructor(private routeService: RouteService) {

  }
  goBack() {
    this.routeService.closeDlg()
  }

  showThreadInfo() {
    const userMsgTrd = this.userMsgTrd()
    if (userMsgTrd !== undefined) {
      if (userMsgTrd.toObjType === 'GROUP') {
        this.routeService.popupDlg(PopupType.GROUP_INFO, { userMsgTrd })
      }
    }
  }
}
