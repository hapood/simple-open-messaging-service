import { Component, signal } from '@angular/core';
import { UserListComponent } from '../user-list/user-list.component';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { MaterialButtonComponent, MaterialButtonType } from "../material-button/material-button.component";
import { GroupService } from '../../services/group.service';
import { UserMessageThread } from '../../services/model';

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

  create() {
    const list = this.selectedList();
    let groupName = list.slice(0, 3).map(item => item.userItem.uniqName).join(', ')
    if (groupName.length > 26) {
      groupName = groupName.slice(0, 22) + ' ...'
    }
    this.groupService.createGroup({ groupName }).subscribe(res => {
      if (res.status === 0) {
        list.forEach(item => {
          this.groupService.inviteUser({ threadId: res.data!.threadId, userId: item.toObjId }).subscribe()
        })
        this.goBack()
      }
    })
  }

  goBack() {
    this.routeService.go(-1)
  }
}
