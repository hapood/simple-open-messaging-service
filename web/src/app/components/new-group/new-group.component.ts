import { Component, signal, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UserListComponent } from '../user-list/user-list.component';
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { MatButtonModule } from '@angular/material/button';
import { GroupService } from '../../services/group.service';
import { ConversationItem } from '../../services/model';
import { UserService } from '../../services/user.service';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';

@Component({
  selector: 'app-new-group',
  imports: [UserListComponent, IconComponent, MatButtonModule, FormsModule, FitDialogDirective],
  templateUrl: './new-group.component.html',
  styleUrl: './new-group.component.scss',
})
export class NewGroupComponent {
  readonly fitOpts = { settleMs: 600, minHeight: 360 } as const
  readonly AppIconType = AppIconType

  /** Group name — auto-derived from the member set until the user edits it (WhatsApp-style prefill). */
  readonly name = signal('')
  private nameEdited = signal(false)

  selectedDict = signal<Record<number, boolean | undefined>>({})
  selectedList = signal<ConversationItem[]>([])

  private readonly routeService = inject(RouteService)
  private readonly groupService = inject(GroupService)
  private readonly userService = inject(UserService)

  /** User typed into the name field → stop auto-deriving from the member set. */
  onNameInput(v: string) {
    this.name.set(v)
    this.nameEdited.set(true)
  }

  onTrdSelect(trdItem: ConversationItem) {
    let dict = { ...this.selectedDict() }
    let list = this.selectedList()
    if (dict[trdItem.id]) {
      dict[trdItem.id] = false
      list = list.filter((item) => item.id !== trdItem.id)
    } else {
      dict[trdItem.id] = true
      list = list.concat(trdItem)
    }
    this.selectedDict.set(dict)
    this.selectedList.set(list)
    if (!this.nameEdited()) this.rederiveName()
  }

  /** Derive a short group name from the creator + selected members (truncated to 31 chars). */
  private rederiveName() {
    let n = this.userService.sessionProfile()?.userExtra.name ?? ''
    for (const item of this.selectedList()) {
      n += ' ' + item.peerUser.userExtra.name
      if (n.length > 26) {
        n = n.slice(0, 22) + ' ...'
        break
      }
    }
    this.name.set(n)
  }

  create() {
    const name = this.name().trim()
    if (!name) return
    // Add the selected friends as members directly at creation (WhatsApp-style) — they are all
    // friends by construction (the picker lists conversations), so no invite-token round-trip.
    const memberIds = this.selectedList().map((item) => item.peerUser.id)
    this.groupService.createGroup({ name, memberIds }).subscribe((res) => {
      if (res.code === 0) {
        this.routeService.closeDlg({ groupId: res.data!.groupId })
      }
    })
  }

  goBack() {
    this.routeService.closeDlg()
  }
}
