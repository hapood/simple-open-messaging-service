import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MsgService } from '../../../services/message.service'
import { User } from '../../../services/Interfaces'

@Component({
  selector: 'app-my-friends',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './my-friends.component.html',
  styleUrl: './my-friends.component.scss'
})
export class MyFriendsComponent {
  uniqName = ""
  userList: User[] = [];
  constructor(private msgService: MsgService) { }
  addFriend() {
    return this.msgService.addFriend(this.uniqName).subscribe(res => {
      console.log(res)
    })
  }
  setFirendName(user: User) {
    this.uniqName = user.uniqName
  }
  getUserList() {
    return this.msgService.getUserList().subscribe(userList => {
      this.userList = userList
    })
  }
  ngOnInit() {
    this.getUserList();
  }
}
