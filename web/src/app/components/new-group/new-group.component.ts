import { Component, signal } from '@angular/core';
import { UserListComponent, DispUserItem } from '../user-list/user-list.component';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { MaterialButtonComponent, MaterialButtonType } from "../material-button/material-button.component";
import { GroupService } from '../../services/group.service';

@Component({
  selector: 'app-new-group',
  standalone: true,
  imports: [UserListComponent, IconComponent, MaterialButtonComponent],
  templateUrl: './new-group.component.html',
  styleUrl: './new-group.component.scss'
})
export class NewGroupComponent {
  selectedDict = signal<Record<number, boolean | undefined>>({})
  selectedList = signal<DispUserItem[]>([])
  AppIconType = AppIconType
  MaterialButtonType = MaterialButtonType

  constructor(private routeService: RouteService, private groupService: GroupService) {

  }

  onTrdSelect(trdItem: DispUserItem) {
    let dict = { ...this.selectedDict() }, list = this.selectedList();
    if (dict[trdItem.userId]) {
      dict[trdItem.userId] = false
      list = list.filter(item => item.userId !== trdItem.userId)
    } else {
      dict[trdItem.userId] = true
      list = list.concat(trdItem)
    }
    this.selectedDict.set(dict)
    this.selectedList.set(list)
  }

  create() {
    const list = this.selectedList();
    let groupName = list.slice(0, 3).map(item => item.name).join(', ')
    if (groupName.length > 12) {
      groupName = groupName.slice(0, 12) + ' ...'
    }
    this.groupService.createGroup({ groupName }).subscribe(res => {
      if (res.status === 0) {
        list.forEach(item => {
          this.groupService.inviteUser({ threadId: res.data!.threadId, userId: item.userId }).subscribe()
        })
        this.goBack()
      }
    })
  }

  goBack() {
    this.routeService.go(-1)
  }
}
