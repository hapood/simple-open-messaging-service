import { Component, signal, input } from '@angular/core';
import { UserListComponent } from '../user-list/user-list.component';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { MatButtonModule } from '@angular/material/button';
import { GroupService } from '../../services/group.service';
import { UserMessageThread } from '../../services/model';

@Component({
    selector: 'app-group-info',
    imports: [UserListComponent, IconComponent, MatButtonModule],
    templateUrl: './group-info.component.html',
    styleUrl: './group-info.component.scss'
})
export class GroupInfoComponent {
  readonly userMsgTrd = input<UserMessageThread>()
  /** optional close handler; when set, goBack() calls it instead of closeDlg
   *  (lets this component be reused in the desktop side panel). */
  readonly closeFn = input<(() => void) | undefined>(undefined)

  selectedDict = signal<Record<number, boolean | undefined>>({})
  selectedList = signal<UserMessageThread[]>([])
  AppIconType = AppIconType

  constructor(private routeService: RouteService, private groupService: GroupService) {

  }

  onTrdSelect(trdItem: UserMessageThread) {
    let dict = { ...this.selectedDict() }, list = this.selectedList();
    if (dict[trdItem.id]) {
      dict[trdItem.id] = false
      list = list.filter(item => item.id !== trdItem.id)
    } else {
      dict[trdItem.id] = true
      list = list.concat(trdItem)
    }
    this.selectedDict.set(dict)
    this.selectedList.set(list)
  }

  invite() {
    const list = this.selectedList(), userMsgTrd = this.userMsgTrd();
    if (userMsgTrd !== undefined) {
      list.forEach(item => {
        this.groupService.inviteUser({ groupId: userMsgTrd.toObjId, userId: item.toObjId }).subscribe()
      })
      alert('success')
    }
  }

  goBack() {
    const fn = this.closeFn()
    if (fn) fn()
    else this.routeService.closeDlg()
  }
}
