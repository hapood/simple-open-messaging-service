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
    // Derive a group name from the members (a real name input lands with the Phase 4 form).
    let name = this.userService.sessionProfile()!.userExtra.name
    for (let i = 0; i < list.length; i++) {
      name += ' ' + list[i].peerUser.userExtra.name
      if (name.length > 26) {
        name = name.slice(0, 22) + ' ...'
        break;
      }
    }
    // Add the selected friends as members directly at creation (WhatsApp-style) — they are all
    // friends by construction (the picker lists conversations), so no invite-token round-trip.
    const memberIds = list.map(item => item.peerUser.id)
    this.groupService.createGroup({ name, memberIds }).subscribe(res => {
      if (res.code === 0) {
        this.routeService.closeDlg({ groupId: res.data!.groupId })
      }
    })
  }

  goBack() {
    this.routeService.closeDlg()
  }
}
