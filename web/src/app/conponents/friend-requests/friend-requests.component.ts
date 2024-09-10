import { Component, input } from '@angular/core';
import { Subject } from 'rxjs';

export const popupName = "Friend Requests"
@Component({
  selector: 'app-friend-requests',
  standalone: true,
  imports: [],
  templateUrl: './friend-requests.component.html',
  styleUrl: './friend-requests.component.scss'
})

export class FriendRequestsComponent {
  subject = input<Subject<any> | undefined>(undefined)
}
