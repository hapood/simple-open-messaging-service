import { Component, input, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { Subject } from 'rxjs';
import { MaterialButtonComponent, MaterialButtonType } from '../../components/material-button/material-button.component';
import { MaterialInputComponent } from '../../components/material-input/material-input.component';

export const popupName = "Friend Requests"
@Component({
  selector: 'app-friend-requests',
  standalone: true,
  imports: [NgClass, MaterialButtonComponent],
  templateUrl: './friend-requests.component.html',
  styleUrl: './friend-requests.component.scss'
})

export class FriendRequestsComponent {
  subject = input<Subject<any> | undefined>(undefined)
  MaterialButtonType = MaterialButtonType
  activeTab = signal(0)
  isShowSendForm = signal(false)

  setTab(tab: number) {
    this.activeTab.set(tab)
  }

  showSendForm() {
    this.isShowSendForm.set(true)
  }
}
