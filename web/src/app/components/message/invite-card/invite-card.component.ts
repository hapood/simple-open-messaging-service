import { Component, input, signal } from '@angular/core';
import { MaterialButtonComponent } from '../../material-button/material-button.component';
import dayjs from 'dayjs';
import { GroupService } from '../../../services/group.service';
import { DisplayMsg } from '../../message-thread/model';

@Component({
    selector: 'app-invite-card',
    imports: [MaterialButtonComponent],
    templateUrl: './invite-card.component.html',
    styleUrl: './invite-card.component.scss'
})

export class InviteCardComponent {
  data = input<DisplayMsg>()
  inviteData = signal({ groupName: '', token: '' })
  expiryDate = signal('')
  status = signal(0)

  constructor(private groupService: GroupService) { }

  ngOnInit() {
    const data = this.data()!
    const inviteData = JSON.parse(data.content)
    this.inviteData.set(inviteData)
    const expDay = dayjs(inviteData.expiryDate)
    this.expiryDate.set(expDay.format("YYYY-MM-DD HH:mm"))
    if (dayjs().isAfter()) {
      this.status.set(1)
    } else {
      this.status.set(0)
    }
  }

  joinGroup() {
    this.groupService.joinGroup({ token: this.inviteData().token }).subscribe(res => {
      if (res.code === 0) {
        alert('joinGroup ok')
      }
    })
  }
}
