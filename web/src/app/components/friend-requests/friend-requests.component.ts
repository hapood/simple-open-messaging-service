import { Component, input, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { Subject } from 'rxjs';
import { MaterialButtonComponent, MaterialButtonType } from '../material-button/material-button.component';
import { RouteService } from '../../services/route.service';
import { MaterialInputComponent } from '../material-input/material-input.component';
import { IconComponent, AppIconType } from '../icon/icon.component';

@Component({
  selector: 'app-friend-requests',
  standalone: true,
  imports: [NgClass, MaterialButtonComponent, IconComponent, MaterialInputComponent],
  templateUrl: './friend-requests.component.html',
  styleUrl: './friend-requests.component.scss'
})

export class FriendRequestsComponent {
  subject = input<Subject<any> | undefined>(undefined)
  activeTab = signal(0)
  isShowSendForm = signal(false)
  isShowBackBtn = signal(false)
  
  AppIconType=AppIconType
  MaterialButtonType = MaterialButtonType

  constructor(private routeService: RouteService,) {
    if (this.routeService.hasPrevRoute()) {
      this.isShowBackBtn.set(true)
    }
  }
  setTab(tab: number) {
    this.activeTab.set(tab)
  }

  showSendForm() {
    this.isShowSendForm.set(true)
  }

  goBack() {
    this.routeService.go(-1)
  }

}
