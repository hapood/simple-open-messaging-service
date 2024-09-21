import { Component, input, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { Subject } from 'rxjs';
import { MaterialButtonComponent, MaterialButtonType } from '../material-button/material-button.component';
import { RouteService } from '../../services/route.service';
import { MaterialInputComponent } from '../material-input/material-input.component';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FormsModule } from '@angular/forms';
import { UserService, User } from '../../services/user.service';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { MsgService } from '../../services/message.service'
import { arrayToDictIndex } from '../../../utils';
import dayjs from 'dayjs';

enum AddTabStatus {
  INIT, EMPTY, SEARCHING, SUCCESS, ERROR
}

@Component({
  selector: 'app-friend-requests',
  standalone: true,
  imports: [UserAvatarComponent, FormsModule, NgClass,
    MaterialButtonComponent, IconComponent, MaterialInputComponent],
  templateUrl: './friend-requests.component.html',
  styleUrl: './friend-requests.component.scss'
})
export class FriendRequestsComponent {
  readonly searchText = signal('')
  readonly userData = signal<User | undefined>(undefined)
  readonly errMsg = signal('')
  readonly reqRspTxt = signal('')
  readonly addTabStatus = signal<AddTabStatus>(AddTabStatus.INIT)
  readonly canAdd = signal(false)
  readonly curSearchText = signal('')
  readonly pendingReqList = signal([] as (User & { status: number, date: string })[])
  readonly toPendingErrTxt = signal('')

  subject = input<Subject<any> | undefined>(undefined)
  activeTab = signal(0)
  isShowBackBtn = signal(false)

  UserAvatarType = UserAvatarType
  AddTabStatus = AddTabStatus
  AppIconType = AppIconType
  MaterialButtonType = MaterialButtonType

  constructor(private routeService: RouteService, private userService: UserService, private msgService: MsgService) {
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
    this.reqRspTxt.set('')
    const curSearchText = this.searchText().trim()
    this.userService.getUserInfoByUniqName({ uniqName: curSearchText }).subscribe({
      next: res => {
        if (res.status === 0) {
          if (res.data!.uniqName === this.userService.sessionProfile()!.uniqName) {
            this.userData.set(res.data)
            this.addTabStatus.set(AddTabStatus.SUCCESS)
            this.canAdd.set(false)
            this.reqRspTxt.set('can not add yourself')
          } else {
            this.msgService.getThreadByUserId({ userId: res.data!.id }).subscribe(res2 => {
              if (res2.status === 1) {
                const thread = res2.data
                // if(thread!.status){

                // }
              }
              this.userData.set(res.data)
              this.canAdd.set(true)
              this.addTabStatus.set(AddTabStatus.SUCCESS)
            })
          }
        } else {
          this.curSearchText.set(curSearchText)
          this.addTabStatus.set(AddTabStatus.EMPTY)
        }
      }, error: () => {
        this.errMsg.set('unknow error occured')
        this.addTabStatus.set(AddTabStatus.ERROR)
      }
    })
  }

  sendRequest() {
    this.reqRspTxt.set('')
    this.userService.sendFriendRequest({ userId: this.userData()!.id }).subscribe({
      next: res => {
        if (res.status === 0) {
          this.reqRspTxt.set('sent successfully')
        } else {
          this.reqRspTxt.set(res.message)
        }
      }, error: () => {
        this.reqRspTxt.set('unknow error occured')
      }
    })
  }

  ngOnInit() {
    this.userService.queryToPending({ take: 20, beforeDate: new Date().getTime() }).subscribe({
      next: (res) => {
        if (res.status === 0) {
          const userIds = res.data!.map(item => item.toObjId)
          this.userService.queryUserInfo({ userIds }).subscribe(res2 => {
            if (res2.status === 0) {
              const dict = arrayToDictIndex(res2.data!, 'id')
              const list = res.data!.map(item => {
                const userData = dict[item.toObjId]
                if (userData) {
                  return { ...userData, status: 0, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss') }
                } else {
                  return { status: -1, date: dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm:ss') } as (User & { status: number, date: string })
                }
              })
              this.pendingReqList.set(list)
            }
            this.toPendingErrTxt.set('unknow error occured')
          })
        } else {
          this.toPendingErrTxt.set('unknow error occured')
        }
      },
      error: (err) => {
        this.toPendingErrTxt.set('unknow error occured')
      }
    })
  }
}
