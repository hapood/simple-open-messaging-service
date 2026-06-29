import { Component, input, signal, computed, EventEmitter, Output, inject, OnInit } from '@angular/core';
import { NgClass } from '@angular/common';
import { UserService } from '../../services/user.service'
import { RouteService, PopupType } from '../../services/route.service'
import { User, UserMessageThread } from '../../services/model'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { EmptyStateComponent } from '../empty-state/empty-state.component';
import { ChatFolder, inFolder } from '../../services/folder.service'

enum ThreadListStatus { LOADING, READY, ERROR }

@Component({
    selector: 'app-thread-list',
    imports: [UserAvatarComponent, NgClass, EmptyStateComponent],
    templateUrl: './thread-list.component.html',
    styleUrl: './thread-list.component.scss'
})
export class ThreadListComponent implements OnInit {
  readonly UserAvatarType = UserAvatarType
  readonly ThreadListStatus = ThreadListStatus
  readonly profile = input<User>()
  readonly selectedId = input<number>()
  /** active folder; undefined = no folder filter (show all) */
  readonly folder = input<ChatFolder | undefined>(undefined)
  /** local name search; '' = no filter. */
  readonly searchText = input('')
  readonly threadList = signal<UserMessageThread[]>([])

  /** 列表加载状态机：LOADING(首次/重试中) → READY | ERROR */
  readonly status = signal<ThreadListStatus>(ThreadListStatus.LOADING)
  readonly errorMsg = signal('')

  /** view model after applying the folder + search filters. */
  readonly filteredThreadList = computed(() => {
    const folder = this.folder(), q = this.searchText().trim().toLowerCase()
    return this.threadList().filter(t => {
      if (folder && !inFolder(t, folder)) return false
      if (q) {
        const name = (t.toObjType === 'P2P' ? t.userItem?.uniqName : t.groupItem?.name) ?? ''
        if (!name.toLowerCase().includes(q)) return false
      }
      return true
    })
  })

  /** 有搜索词但过滤后无结果 →「搜索无结果」态（区别于真空态，不带 CTA） */
  readonly isSearchEmpty = computed(() =>
    this.searchText().trim().length > 0 && this.filteredThreadList().length === 0
  )

  @Output() onSelect = new EventEmitter<UserMessageThread>()

  private readonly userService = inject(UserService)
  private readonly routeService = inject(RouteService)

  genThreadList() {
    // take:200 — folders must filter over the full thread set, not the first page.
    // (true infinite scroll is a follow-up; 200 covers personal thread counts.)
    this.status.set(ThreadListStatus.LOADING)
    this.errorMsg.set('')
    return this.userService.queryUserThreadValid({ take: 200, skip: 0 }).subscribe({
      next: res => {
        if (res.code === 0) {
          this.threadList.set(res.data ?? [])
          this.status.set(ThreadListStatus.READY)
        } else {
          // 修正：原代码 `throw new Error(res.message)` 写在 next 回调里，RxJS 会吞掉它
          // （既不进 error 分支也不向调用者传播），导致接口失败时列表永久卡空白。
          // 改为显式进 ERROR 态并回显后端 message，让用户能感知并重试。
          this.errorMsg.set(res.message || '加载会话列表失败')
          this.status.set(ThreadListStatus.ERROR)
        }
      },
      error: () => {
        // HTTP 层失败（断网 / 5xx）——原代码完全没覆盖这条路径
        this.errorMsg.set('网络错误，请重试')
        this.status.set(ThreadListStatus.ERROR)
      },
    })
  }

  /** 真空态 CTA：打开好友请求弹窗（与 icon-rail 同路径） */
  openFriendRequests() {
    this.routeService.popupDlg(PopupType.FRIEND_REQUESTS)
  }

  onUsrTrdClick(userMsgTrd: UserMessageThread) {
    this.onSelect.emit(userMsgTrd)
  }

  ngOnInit() {
    this.genThreadList();
  }
}
