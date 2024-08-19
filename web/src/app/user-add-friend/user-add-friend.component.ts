import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../services/chat.service'
import { User } from '../../services/Interfaces'

@Component({
  selector: 'app-user-add-friend',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './user-add-friend.component.html',
  styleUrl: './user-add-friend.component.scss'
})
export class UserAddFriendComponent {
  uniqName = ""
  userList: User[] = [];
  constructor(private chatService: ChatService) { }
  addFriend() {
    return this.chatService.addFriend(this.uniqName).subscribe(res => {
      console.log(res)
    })
  }
  setFirendName(user: User) {
    this.uniqName = user.uniqName
  }
  getUserList() {
    return this.chatService.getUserList().subscribe(userList => {
      this.userList = userList
    })
  }
  ngOnInit() {
    this.getUserList();
  }
}
