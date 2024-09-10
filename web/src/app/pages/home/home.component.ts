import { Component, signal } from '@angular/core';
import { User } from '../../services/model'
import { HomeHeaderComponent } from '../../components/home-header/home-header.component';
import { UserService } from '../../services/user.service'
import { ThreadListComponent } from '../../components/thread-list/thread-list.component';
import { MessageThreadComponent } from '../../components/message-thread/friend-message.component';
import { RootPopupComponent } from '../../components/root-popup/root-popup.component';
import { AuthService } from '../../services/auth.service';
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

  constructor(private userService: UserService, private authService: AuthService) { }

  ngOnInit() {
    this.userService.updateSessionProfile();
    this.authService.renewAccessToken()
  }

}
