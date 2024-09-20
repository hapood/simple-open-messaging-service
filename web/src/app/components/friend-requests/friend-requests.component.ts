import { Component, input, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { Subject } from 'rxjs';
import { MaterialButtonComponent, MaterialButtonType } from '../material-button/material-button.component';
import { RouteService } from '../../services/route.service';
import { MaterialInputComponent } from '../material-input/material-input.component';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FormsModule } from '@angular/forms';
import { UserService, User } from '../../services/user.service';

enum AddTabStatus {
  EMPTY, SEARCHING, SUCCESS, ERROR
}

@Component({
  selector: 'app-friend-requests',
  standalone: true,
  imports: [FormsModule, NgClass, MaterialButtonComponent, IconComponent, MaterialInputComponent],
  templateUrl: './friend-requests.component.html',
  styleUrl: './friend-requests.component.scss'
})
export class FriendRequestsComponent {
  readonly searchText = signal('')
  readonly userData = signal<User | undefined>(undefined)
  readonly errMsg = signal('')
  readonly addTabStatus = signal<AddTabStatus>(AddTabStatus.EMPTY)
  subject = input<Subject<any> | undefined>(undefined)
  activeTab = signal(0)
  isShowBackBtn = signal(false)

  AddTabStatus=AddTabStatus
  AppIconType = AppIconType
  MaterialButtonType = MaterialButtonType

  constructor(private routeService: RouteService, private userService: UserService) {
    if (this.routeService.hasPrevRoute()) {
      this.isShowBackBtn.set(true)
    }
  }
  setTab(tab: number) {
    this.activeTab.set(tab)
  }

  goBack() {
    this.routeService.go(-1)
  }

  searchUser() {
    this.addTabStatus.set(AddTabStatus.SEARCHING)
    this.userService.getUserInfoByUniqName({ uniqName: this.searchText().trim() }).subscribe({
      next: res => {
        if (res.status === 0) {
          this.userData.set(res.data)
          this.addTabStatus.set(AddTabStatus.SUCCESS)
        } else {
          this.addTabStatus.set(AddTabStatus.ERROR)
          this.errMsg.set(res.message)
        }
      }, error: () => {
        this.errMsg.set('unknow error occured')
        this.addTabStatus.set(AddTabStatus.ERROR)
      }
    })
  }
}
