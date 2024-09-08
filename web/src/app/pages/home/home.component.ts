import { Component, signal } from '@angular/core';
import { User } from '../../services/Interfaces'
import { HomeHeaderComponent } from '../../components/home-header/home-header.component';
import { MsgService } from '../../services/message.service'
import { ThreadListComponent } from '../../components/thread-list/thread-list.component';
import { MessageThreadComponent } from '../../components/message-thread/friend-message.component';
import { RootPopupComponent } from '../../components/root-popup/root-popup.component';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [HomeHeaderComponent, ThreadListComponent, MessageThreadComponent, RootPopupComponent],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss'
})

export class HomeComponent {
  readonly profile = signal<User | undefined>(undefined)
  curThreadId = signal<number | undefined>(undefined)

  constructor(private msgService: MsgService) { }

  ngOnInit() {
    this.getMyInfo();
  }

  getMyInfo() {
    return this.msgService.getMyProfile().subscribe({
      next: profile => {
        this.profile.set(profile)
      },
      error: (err) => {

        console.error(err)
      }
    })
  }
}
