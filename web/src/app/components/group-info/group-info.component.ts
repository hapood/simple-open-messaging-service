import { Component, signal, input } from '@angular/core';
import { UserListComponent } from '../user-list/user-list.component';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { MaterialButtonComponent, MaterialButtonType } from "../material-button/material-button.component";
import { GroupService } from '../../services/group.service';
import { UserMessageThread } from '../../services/model';

@Component({
  selector: 'app-group-info',
  standalone: true,
  imports: [UserListComponent, IconComponent, MaterialButtonComponent],
  templateUrl: './group-info.component.html',
  styleUrl: './group-info.component.scss'
})
export class GroupInfoComponent {
  readonly userMsgTrd = input<UserMessageThread>()

  selectedDict = signal<Record<number, boolean | undefined>>({})
  selectedList = signal<UserMessageThread[]>([])
  AppIconType = AppIconType
  MaterialButtonType = MaterialButtonType

  constructor(private routeService: RouteService, private groupService: GroupService) {

  }

  onTrdSelect(trdItem: UserMessageThread) {
    console.log(trdItem)
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
    this.routeService.go(-1)
  }
}
