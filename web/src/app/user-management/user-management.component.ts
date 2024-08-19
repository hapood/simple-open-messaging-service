import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../services/chat.service'
import { User } from '../../services/Interfaces'

@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './user-management.component.html',
  styleUrl: './user-management.component.scss'
})
export class UserManagementComponent {
  uniqName = "hapood"
  password = "512512";
  userList: User[] = [];
  constructor(private chatService: ChatService) { }

  addUser() {
    return this.chatService.addUser({ uniqName: this.uniqName, password: this.password }).subscribe(res => console.log(res))
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
