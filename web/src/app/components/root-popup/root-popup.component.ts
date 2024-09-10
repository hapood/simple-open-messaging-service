import { Component, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { PopupService, PopupType } from '../../services/popup.service';
import { MaterialDialogComponent } from '../material-dialog/material-dialog.component';
import { Subject } from 'rxjs';
import { ComponentEventSubject } from '../../../utils'
import { RouteService } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FriendRequestsComponent, popupName as FrdReqName } from '../../conponents/friend-requests/friend-requests.component';

const componentDict = {
  [PopupType.FRIEND_REQUESTS]: { com: FriendRequestsComponent, name: FrdReqName }
}

@Component({
  selector: 'app-root-popup',
  standalone: true,
  imports: [MaterialDialogComponent, IconComponent, NgComponentOutlet],
  templateUrl: './root-popup.component.html',
  styleUrl: './root-popup.component.scss'
})
export class RootPopupComponent {
  readonly PopupType = PopupType
  readonly popupType = signal<PopupType | undefined>(undefined)
  curSubject = signal<Subject<ComponentEventSubject<any>> | undefined>(undefined) //won't be undefined when template call it
  lastPopupType: PopupType | undefined
  AppIconType = AppIconType
  isShowBackBtn = signal(false)
  popupTitle = signal('')
  currentPopupCom = signal<any>(undefined)

  constructor(private popupService: PopupService, private routeService: RouteService,) {
    if (this.routeService.hasPrevRoute()) {
      this.isShowBackBtn.set(true)
    }
    console.log(this.popupType)
    this.popupService.subject.subscribe({
      next: (cmd) => {
        if (cmd.isShow === true) {
          const dictItem = componentDict[cmd.popupType as PopupType]
          if (dictItem !== undefined) {
            this.clearLastSubject()
            this.curSubject.set(cmd.subject)
            this.popupType.set(cmd.popupType)
            this.currentPopupCom.set(dictItem.com as Component)
            this.popupTitle.set(dictItem.name)
          }
        } else {
          this.clearLastSubject();
          this.curSubject.set(undefined)
          this.popupType.set(undefined)
        }
      }
    })
  }

  goBack() {
    this.routeService.go(-1)
  }

  clearLastSubject() {
    this.currentPopupCom.set(undefined)
    const subj = this.curSubject()
    if (subj !== undefined) {
      subj.complete()
      subj.unsubscribe()
    }
  }

  ngOnDestroy() {
    this.clearLastSubject()
  }
}
