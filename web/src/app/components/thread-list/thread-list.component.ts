import { Component, input, signal, EventEmitter, Output } from '@angular/core';
import { NgClass } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { UserService } from '../../services/user.service'
import { MsgThread, User, ThreadItem } from '../../services/model'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { switchMap, of } from 'rxjs';

interface DispThreadItem { id: number, userId: number, name: string, icon: string, threadItem: ThreadItem }
@Component({
  selector: 'app-thread-list',
  standalone: true,
  imports: [UserAvatarComponent, NgClass],
  templateUrl: './thread-list.component.html',
  styleUrl: './thread-list.component.scss'
})
export class ThreadListComponent {
  UserAvatarType = UserAvatarType
  readonly profile = input<User>()
  readonly selectedId = input<number>()
  readonly threadList = signal<DispThreadItem[]>([])

  @Output() onSelect = new EventEmitter<number>()

  userInfoDict = signal<Record<string, User>>({})

  constructor(private userService: UserService, private route: ActivatedRoute, private router: Router) { }

  genThreadList() {
    return this.userService.queryUserThreadValid({ take: 10, skip: 0 }).pipe(switchMap(({ status, message, data: threadList }) => {
      if (status == 0) {
        return this.userService.queryUserInfo({ userIds: threadList!.map(item => item.toObjId) }).pipe(switchMap(({ status, message, data: userList }) => {
          const dict: Record<number, User> = {}
          if (status == 0) {
            const dispThreadList: DispThreadItem[] = []
            userList!.forEach(item => dict[item.id] = item)
            threadList!.forEach(thread => {
              const user = dict[thread.toObjId]
              if (user) {
                dispThreadList.push({
                  id: thread.id,
                  userId: thread.toObjId,
                  name: user.userExtra.name,
                  icon: user.userExtra.avatar,
                  threadItem: thread.threadItem
                })
              }
            })
            return of(dispThreadList)
          } else {
            throw new Error(message)
          }
        }))
      } else {
        throw new Error(message)
      }
    })).subscribe(threadList => {
      this.threadList.set(threadList)
    })
  }

  onThreadClick(thread: DispThreadItem) {
    this.onSelect.emit(thread.id)
  }

  ngOnInit() {
    this.genThreadList();
  }
}
