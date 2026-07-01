import { Component, signal } from '@angular/core';
import { UserListComponent } from '../user-list/user-list.component';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { MatButtonModule } from '@angular/material/button';
import { GroupService } from '../../services/group.service';
import { ConversationItem } from '../../services/model';
import { UserService } from '../../services/user.service';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';
@Component({
    selector: 'app-new-group',
    imports: [UserListComponent, IconComponent, MatButtonModule, FitDialogDirective],
    templateUrl: './new-group.component.html',
    styleUrl: './new-group.component.scss'
})
export class NewGroupComponent {
  readonly fitOpts = { settleMs: 600, minHeight: 360 } as const
  selectedDict = signal<Record<number, boolean | undefined>>({})
  selectedList = signal<ConversationItem[]>([])
  AppIconType = AppIconType

  constructor(private routeService: RouteService, private groupService: GroupService, private userService: UserService) {

  }

  onTrdSelect(trdItem: ConversationItem) {
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

  create() {
    const list = this.selectedList();
    let groupName = this.userService.sessionProfile()!.userExtra.name
    for (let i = 0; i < list.length; i++) {
      groupName += ' ' + list[i].peerUser.userExtra.name
      if (groupName.length > 26) {
        groupName = groupName.slice(0, 22) + ' ...'
        break;
      }
    }
    this.groupService.createGroup({ groupName }).subscribe(res => {
      if (res.code === 0) {
        const groupId = res.data!.groupId
        list.forEach(item => {
          this.groupService.inviteUser({ groupId, userId: item.peerUser.id }).subscribe()
        })
        this.routeService.closeDlg({ groupId })
      }
    })
  }

  goBack() {
    this.routeService.closeDlg()
  }
}
