import { Component, signal, computed, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { RouteService, PopupType } from '../../services/route.service';
import { UserService } from '../../services/user.service';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';

/**
 * 编辑资料弹窗（WhatsApp 极简）：头像 + 昵称 + 简介；登录 handle 只读。
 * 头像走既有 update-avatar（sharp 多档），昵称/简介走 update-profile；
 * 任一成功都回读 sessionProfile（rail/抽屉/预览都绑 signal，自动刷新）。
 */
@Component({
  selector: 'app-edit-profile',
  imports: [FormsModule, MatButtonModule, UserAvatarComponent, IconComponent, FitDialogDirective],
  templateUrl: './edit-profile.component.html',
  styleUrl: './edit-profile.component.scss',
})
export class EditProfileComponent {
  private readonly routeService = inject(RouteService)
  private readonly userService = inject(UserService)

  readonly UserAvatarType = UserAvatarType
  readonly AppIconType = AppIconType
  readonly fitOpts = { minHeight: 380 } as const

  readonly sessionProfile = this.userService.sessionProfile

  readonly name = signal('')
  readonly bio = signal('')
  readonly nameHint = signal('')
  readonly isNameValid = signal(true)
  readonly uploading = signal(false)
  readonly saving = signal(false)

  constructor() {
    const p = this.sessionProfile()
    this.name.set(p?.userExtra?.name ?? '')
    this.bio.set(p?.userExtra?.bio ?? '')

    // 昵称校验：非空（去空格）且 ≤30。仿 register.component.ts 的 effect 校验模式。
    effect(() => {
      const n = this.name().trim()
      if (n.length === 0) {
        this.isNameValid.set(false)
        this.nameHint.set('昵称不能为空')
      } else if (n.length > 30) {
        this.isNameValid.set(false)
        this.nameHint.set('不超过 30 个字符')
      } else {
        this.isNameValid.set(true)
        this.nameHint.set('')
      }
    })
  }

  /** 仅当昵称合法、未在请求中、且至少一项相对当前 session 改动时才可保存。 */
  readonly canSave = computed(() => {
    const p = this.sessionProfile()
    if (!p) return false
    const nameChanged = this.name().trim() !== (p.userExtra?.name ?? '')
    const bioChanged = this.bio() !== (p.userExtra?.bio ?? '')
    return this.isNameValid() && !this.saving() && !this.uploading() && (nameChanged || bioChanged)
  })

  onAvatarPicked(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = '' // 清空，允许重复选同一文件
    if (!file) return
    this.uploading.set(true)
    this.userService.updateAvatar(file).subscribe({
      next: () => {
        this.uploading.set(false)
        // 头像已落库 → 回读 sessionProfile，rail/抽屉/预览随之刷新。
        this.userService.updateSessionProfile()
      },
      error: () => {
        this.uploading.set(false)
      },
    })
  }

  save() {
    if (!this.canSave()) return
    this.saving.set(true)
    this.userService.updateProfile({ name: this.name().trim(), bio: this.bio() }).subscribe({
      next: (res) => {
        this.saving.set(false)
        if (res.code === 0) {
          this.userService.updateSessionProfile()
          this.routeService.closeDlg(true)
        }
      },
      error: () => {
        this.saving.set(false)
      },
    })
  }

  goBack() {
    this.routeService.closeDlg()
  }

  openSessions() {
    this.routeService.popupDlg(PopupType.SESSIONS)
  }
}
