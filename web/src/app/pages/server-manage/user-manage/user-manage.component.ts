import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MsgService } from '../../../services/message.service'
import { User } from '../../../services/Interfaces'

@Component({
  selector: 'app-user-manage',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './user-manage.component.html',
  styleUrl: './user-manage.component.scss'
})
export class UserManageComponent {
  uniqName = "hapood"
  password = "512512";
  userList: User[] = [];
  constructor(private msgService: MsgService) { }

  addUser() {
    return this.msgService.addUser({ uniqName: this.uniqName, password: this.password }).subscribe(res => console.log(res))
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
