import { Component, input, signal, EventEmitter, Output, computed } from '@angular/core';
import { UserService } from '../../services/user.service'
import { ConversationItem } from '../../services/model'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';

@Component({
    selector: 'app-user-list',
    imports: [UserAvatarComponent],
    templateUrl: './user-list.component.html',
    styleUrl: './user-list.component.scss'
})

export class UserListComponent {
  UserAvatarType = UserAvatarType
  readonly selectedDict = input<Record<number, boolean | undefined>>()
  readonly threadList = signal<ConversationItem[]>([])

  readonly dispThreadList = computed(() => {
    const threadList = this.threadList(), selectedDict = this.selectedDict()
    if (selectedDict !== undefined) {
      return threadList.map(thread => {
        return { ...thread, selected: selectedDict[thread.id] } as (ConversationItem & { selected: undefined })
      })
    } else { return threadList as (ConversationItem & { selected: undefined })[] }
  })

  @Output() onSelect = new EventEmitter<ConversationItem & { selected: undefined }>()

  constructor(private userService: UserService) { }

  genThreadList() {
    return this.userService.queryUserThreadValid({ take: 10, skip: 0, type: "P2P" }).subscribe(res => {
      if (res.code == 0) {
        this.threadList.set(res.data!)
      } else {
        throw new Error(res.message)
      }
    })
  }

  onUsrTrdClick(userMsgTrd: ConversationItem & { selected: undefined }) {
    this.onSelect.emit(userMsgTrd)
  }

  ngOnInit() {
    this.genThreadList();
  }
}
