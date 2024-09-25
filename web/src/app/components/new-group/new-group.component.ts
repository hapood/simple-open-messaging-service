import { Component, signal } from '@angular/core';
import { UserListComponent } from '../user-list/user-list.component';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { MaterialButtonComponent, MaterialButtonType } from "../material-button/material-button.component";
import { GroupService } from '../../services/group.service';
import { UserMessageThread } from '../../services/model';
import { UserService } from '../../services/user.service';
@Component({
  selector: 'app-new-group',
  standalone: true,
  imports: [UserListComponent, IconComponent, MaterialButtonComponent],
  templateUrl: './new-group.component.html',
  styleUrl: './new-group.component.scss'
})
export class NewGroupComponent {
  selectedDict = signal<Record<number, boolean | undefined>>({})
  selectedList = signal<UserMessageThread[]>([])
  AppIconType = AppIconType
  MaterialButtonType = MaterialButtonType

  constructor(private routeService: RouteService, private groupService: GroupService, private userService: UserService) {

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

  create() {
    const list = this.selectedList();
    let groupName = this.userService.sessionProfile()!.userExtra.name
    for (let i = 0; i < list.length; i++) {
      groupName += ' ' + list[i].userItem.userExtra
      if (groupName.length > 26) {
        groupName = groupName.slice(0, 22) + ' ...'
        break;
      }
    }
    this.groupService.createGroup({ groupName }).subscribe(res => {
      if (res.status === 0) {
        list.forEach(item => {
          this.groupService.inviteUser({ groupId: res.data!.groupId, userId: item.toObjId }).subscribe()
        })
        this.goBack()
      }
    })
  }

  goBack() {
    this.routeService.go(-1)
  }
}
