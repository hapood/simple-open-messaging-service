import { Component, signal, computed, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService, PopupType } from '../../services/route.service';
import { UserService } from '../../services/user.service';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../icon/icon.component';

/**
 * Edit-profile dialog (WhatsApp-minimal): avatar + display name + bio; the login handle is read-only.
 * Avatar goes through the existing update-avatar (sharp multi-size); name/bio go through update-profile;
 * either success re-reads sessionProfile (rail/drawer/preview all bind the signal and refresh automatically).
 */
@Component({
  selector: 'app-edit-profile',
  imports: [FormsModule, MatButtonModule, UserAvatarComponent, IconComponent, TranslocoPipe],
  templateUrl: './edit-profile.component.html',
  styleUrl: './edit-profile.component.scss',
})
export class EditProfileComponent {
  private readonly routeService = inject(RouteService)
  private readonly userService = inject(UserService)
  private readonly transloco = inject(TranslocoService)

  readonly UserAvatarType = UserAvatarType
  readonly AppIconType = AppIconType

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

    // Name validation: non-empty (trimmed) and ≤30. Mirrors register.component.ts's effect-based validation.
    effect(() => {
      const n = this.name().trim()
      if (n.length === 0) {
        this.isNameValid.set(false)
        this.nameHint.set(this.transloco.translate('profile.nameEmpty'))
      } else if (n.length > 30) {
        this.isNameValid.set(false)
        this.nameHint.set(this.transloco.translate('profile.nameTooLong'))
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
    // Hand the raw file to the cropper; upload only the cropped square it returns.
    // Cancel/back yields no result, so nothing uploads.
    this.routeService.popupDlg(PopupType.AVATAR_EDITOR, { file }, (res) => {
      if (res?.file) this.uploadAvatarFile(res.file)
    })
  }

  private uploadAvatarFile(file: File) {
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
